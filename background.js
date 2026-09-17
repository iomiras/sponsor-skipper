// MV3 service worker: sole owner of chrome.storage.local, the proxy fetch,
// and the offscreen document that runs the transcription Worker.
// Message contract:
//   content.js -> here:      { type: 'getState', videoId } -> VideoState
//   content.js -> here:      { type: 'transcribeChunk', videoId, chunkRange, pcm, sampleRate }
//   here -> offscreen.js:    { type: 'runTranscribe', videoId, chunkRange, pcm, sampleRate }
//   offscreen.js -> here:    { type: 'transcribeResult', videoId, chunkRange, segments }
//   here -> content.js:      { type: 'chunkResult', videoId, chunkRange, sponsorRanges }
//   content.js -> here:      { type: 'setEnabled', enabled } -> { enabled }
//   content.js -> here:      { type: 'getEnabled' } -> { enabled }

let offscreenReady = null;
async function ensureOffscreenDocument() {
  if (!offscreenReady) {
    offscreenReady = (async () => {
      const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
      if (existing.length > 0) return;
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['WORKERS'],
        justification: 'runs Whisper transcription in a Worker, outside youtube.com\'s CSP',
      });
    })();
  }
  return offscreenReady;
}

// keyed `${videoId}:${chunkStart}`, since the offscreen doc is a singleton shared across tabs.
const pendingChunks = new Map();

const PROXY_URL = 'http://localhost:8787/classify';
const NOUL_THRESHOLD = 0.6; // starting default, tune via testing
const MERGE_GAP_SECONDS = 15;
const RANGE_BUFFER_SECONDS = 2;
const KEYWORD_PREFILTER = [
  'sponsor', 'sponsored', 'promo', 'promo code', 'discount', 'off your',
  'use code', 'link in the description', 'link below', 'today\'s video is brought',
  'brought to you by', 'check out', 'partnered with', 'affiliate'
];

function storageKey(videoId) {
  return `ytsb:${videoId}`;
}

function emptyState(videoId) {
  return { videoId, processedChunks: [], sponsorRanges: [], candidateSegments: [] };
}

async function getState(videoId) {
  const key = storageKey(videoId);
  const result = await chrome.storage.local.get(key);
  return result[key] || emptyState(videoId);
}

async function setState(videoId, state) {
  await chrome.storage.local.set({ [storageKey(videoId)]: state });
}

function mergeChunkRange(processedChunks, [start, end]) {
  const merged = [...processedChunks, [start, end]].sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const range of merged) {
    const last = out[out.length - 1];
    if (last && range[0] <= last[1]) {
      last[1] = Math.max(last[1], range[1]);
    } else {
      out.push(range);
    }
  }
  return out;
}

// segments with no sponsor vocabulary are dropped before the network round trip.
function keywordPrefilter(segments) {
  return segments.filter((seg) => {
    const text = seg.text.toLowerCase();
    return KEYWORD_PREFILTER.some((kw) => text.includes(kw));
  });
}

async function classifySegments(segments) {
  if (segments.length === 0) return {};
  const body = {
    segments: segments.map((seg) => ({ id: seg.id, text: seg.text, context: seg.context || '' })),
  };
  console.log(`[ytsb] sending ${segments.length} segment(s) to Jev for classification:`, body.segments);

  const maxRetries = 4;
  let attempt = 0;
  while (true) {
    let res;
    try {
      res = await fetch(PROXY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      console.warn(`[ytsb] Jev request failed (attempt ${attempt}):`, err.message);
      if (attempt >= maxRetries) throw err;
      await backoff(attempt++);
      continue;
    }
    if (res.status === 429 || res.status === 529) {
      console.warn(`[ytsb] Jev proxy overloaded (${res.status}), retrying...`);
      if (attempt >= maxRetries) throw new Error(`proxy overloaded: ${res.status}`);
      await backoff(attempt++);
      continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error(`[ytsb] Jev proxy error ${res.status}:`, text);
      throw new Error(`proxy error: ${res.status}`);
    }
    const data = await res.json();
    console.log('[ytsb] Jev response:', data.results);
    return data.results || {};
  }
}

function backoff(attempt) {
  const ms = Math.min(1000 * 2 ** attempt, 8000);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mergeSponsorRanges(candidateSegments) {
  const candidates = candidateSegments
    .filter((seg) => seg.confidence >= NOUL_THRESHOLD)
    .sort((a, b) => a.start - b.start);

  const ranges = [];
  for (const seg of candidates) {
    const last = ranges[ranges.length - 1];
    if (last && seg.start - last.rawEnd <= MERGE_GAP_SECONDS) {
      last.rawEnd = Math.max(last.rawEnd, seg.end);
    } else {
      ranges.push({ rawStart: seg.start, rawEnd: seg.end });
    }
  }

  return ranges.map((r) => ({
    start: Math.max(0, r.rawStart - RANGE_BUFFER_SECONDS),
    end: r.rawEnd + RANGE_BUFFER_SECONDS,
  }));
}

async function handleChunkProcessed(videoId, chunkRange, segments) {
  const state = await getState(videoId);
  state.processedChunks = mergeChunkRange(state.processedChunks, chunkRange);

  const relevant = keywordPrefilter(segments);
  if (relevant.length > 0) {
    const withContext = relevant.map((seg, i) => ({
      ...seg,
      context: [relevant[i - 1]?.text, relevant[i + 1]?.text].filter(Boolean).join(' / '),
    }));
    const results = await classifySegments(withContext);
    for (const seg of relevant) {
      const noul = results[seg.id]?.noul ?? 0;
      state.candidateSegments.push({ start: seg.start, end: seg.end, text: seg.text, confidence: noul });
    }
  }

  state.sponsorRanges = mergeSponsorRanges(state.candidateSegments);
  await setState(videoId, state);
  return state;
}

function checkedUpTo(processedChunks) {
  let end = 0;
  const sorted = [...processedChunks].sort((a, b) => a[0] - b[0]);
  for (const [start, stop] of sorted) {
    if (start > end) break;
    end = Math.max(end, stop);
  }
  return end;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case 'getState':
        sendResponse(await getState(msg.videoId));
        break;
      case 'getPopupInfo': {
        const state = await getState(msg.videoId);
        const { enabled = true } = await chrome.storage.local.get('enabled');
        sendResponse({
          enabled,
          sponsorRanges: state.sponsorRanges,
          checkedUpTo: checkedUpTo(state.processedChunks),
        });
        break;
      }
      case 'transcribeChunk': {
        await ensureOffscreenDocument();
        pendingChunks.set(`${msg.videoId}:${msg.chunkRange[0]}`, sender.tab.id);
        console.log(`[ytsb] relaying chunk [${msg.chunkRange[0]}s-${msg.chunkRange[1]}s] to offscreen worker`);
        chrome.runtime.sendMessage({
          type: 'runTranscribe',
          videoId: msg.videoId,
          chunkRange: msg.chunkRange,
          pcm: msg.pcm,
          sampleRate: msg.sampleRate,
        });
        sendResponse({ ok: true });
        break;
      }
      case 'transcribeResult': {
        const key = `${msg.videoId}:${msg.chunkRange[0]}`;
        const tabId = pendingChunks.get(key);
        pendingChunks.delete(key);
        const state = await handleChunkProcessed(msg.videoId, msg.chunkRange, msg.segments);
        if (tabId != null) {
          chrome.tabs.sendMessage(tabId, {
            type: 'chunkResult',
            videoId: msg.videoId,
            chunkRange: msg.chunkRange,
            sponsorRanges: state.sponsorRanges,
          });
        }
        break;
      }
      case 'setEnabled':
        await chrome.storage.local.set({ enabled: msg.enabled });
        sendResponse({ enabled: msg.enabled });
        break;
      case 'getEnabled': {
        const { enabled = true } = await chrome.storage.local.get('enabled');
        sendResponse({ enabled });
        break;
      }
      default:
        sendResponse({ error: `unknown message type: ${msg.type}` });
    }
  })();
  return true; // keep the message channel open for the async response
});
