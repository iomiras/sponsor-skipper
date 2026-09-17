importScripts('timeline.js');

// MV3 service worker: sole owner of chrome.storage.local and the local server calls
// (both /transcribe and /classify - the only file that talks to localhost:8787).
// Message contract:
//   content.js -> here: { type: 'getState', videoId } -> VideoState
//   content.js -> here: { type: 'transcribeChunk', videoId, chunkRange, pcm: base64, sampleRate }
//                        -> { videoId, chunkRange, sponsorRanges } (via sendResponse, once
//                           transcription + classification finish - not a push message)
//   content.js -> here: { type: 'setEnabled', enabled } -> { enabled }
//   content.js -> here: { type: 'getEnabled' } -> { enabled }

const TRANSCRIBE_URL = 'http://localhost:8787/transcribe';
const PROXY_URL = 'http://localhost:8787/classify';
const NOUL_THRESHOLD = 0.6; // starting default, tune via testing
const MERGE_GAP_SECONDS = 15;
const RANGE_BUFFER_SECONDS = 2;
const preparedVideos = new Map();
const videoJobs = new Map();

function storageKey(videoId) {
  return `ytsb:ahead-v1:${videoId}`;
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

async function transcribeAudio(pcm, sampleRate, chunkStart) {
  if (typeof pcm !== 'string' || pcm.length === 0) {
    throw new Error('expected non-empty base64 PCM; reload the extension and refresh the YouTube tab');
  }
  const res = await fetch(TRANSCRIBE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pcm, sampleRate, chunkStart }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`transcribe server error ${res.status}: ${text}`);
  }
  const data = await res.json();
  return data.segments || [];
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

  // Brand pitches often have no explicit "sponsor" or "promo code" phrase.
  // Let the classifier judge all spoken text, using adjacent segments as context.
  const spoken = segments.filter((seg) => seg.text.trim().length > 0);
  console.log(`[ytsb] video=${videoId} chunk=[${chunkRange.join(', ')}]: ${spoken.length} non-empty transcript segment(s) for classification`);
  if (spoken.length === 0) {
    console.log('[ytsb] skipping /classify because the transcript is empty');
  }
  if (spoken.length > 0) {
    const withContext = spoken.map((seg, i) => ({
      ...seg,
      context: seg.context ?? [spoken[i - 1]?.text, spoken[i + 1]?.text].filter(Boolean).join(' / '),
    }));
    const results = await classifySegments(withContext);
    for (const seg of spoken) {
      const noul = results[seg.id]?.noul;
      if (!Number.isFinite(noul) || noul < 0 || noul > 1) throw new Error(`Missing or invalid classifier score for ${seg.id}`);
      console.log(`[ytsb] segment ${seg.id}: sponsor score=${noul}, threshold=${NOUL_THRESHOLD}, accepted=${noul >= NOUL_THRESHOLD}`);
      state.candidateSegments = state.candidateSegments.filter((candidate) => candidate.id !== seg.id);
      state.candidateSegments.push({ id: seg.id, start: seg.start, end: seg.end, text: seg.text, confidence: noul });
    }
  }

  state.sponsorRanges = mergeSponsorRanges(state.candidateSegments);
  console.log(`[ytsb] video=${videoId} sponsor ranges:`, state.sponsorRanges);
  await setState(videoId, state);
  return state;
}

async function serverRequest(endpoint, body) {
  const response = await fetch(`http://localhost:8787/${endpoint}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `${endpoint} failed (${response.status})`);
  if (response.status === 202 && data.jobId) {
    const deadline = Date.now() + 5 * 60 * 1000;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      const job = await serverRequest('video-job', { jobId: data.jobId });
      if (!job.pending) return job.result;
    }
    throw new Error('Video preparation timed out. Check the server and retry.');
  }
  return data;
}

async function analyzeAhead(videoId, position) {
  if (!/^[\w-]{11}$/.test(videoId) || !Number.isFinite(position) || position < 0) throw new Error('Invalid video or playback position');
  let state = await getState(videoId);
  if (state.duration && ytsbTimeline.checkedEnd(state.processedChunks, position) >= Math.min(state.duration, position + 120)) return state;
  let prepared = preparedVideos.get(videoId);
  if (!prepared) {
    if (preparedVideos.size >= 10) preparedVideos.delete(preparedVideos.keys().next().value);
    prepared = await serverRequest('prepare-video', { videoId });
    preparedVideos.set(videoId, prepared);
  }
  state = { ...state, duration: prepared.duration, source: prepared.source, language: prepared.language };
  await setState(videoId, state);
  const range = ytsbTimeline.nextRange(state.processedChunks, position, prepared.duration, prepared.source === 'captions' ? 60 : 30);
  if (!range) return state;
  let segments;
  if (prepared.source === 'captions') {
    segments = prepared.segments.flatMap((segment, i, all) => segment.end > range[0] && segment.start < range[1]
      ? [{ ...segment, context: [all[i - 1]?.text, all[i + 1]?.text].filter(Boolean).join(' / ') }]
      : []);
    console.log(`[ytsb] caption analysis video=${videoId} range=[${range}] segments=${segments.length}; Whisper not needed`);
  } else {
    ({ segments } = await serverRequest('transcribe-video', { videoId, start: range[0], end: range[1] }));
  }
  return handleChunkProcessed(videoId, range, segments);
}

function queueAnalysis(videoId, position) {
  // Two tabs of the same video must not overwrite each other's cached ranges.
  const previous = videoJobs.get(videoId) || Promise.resolve();
  const job = previous.catch(() => {}).then(() => analyzeAhead(videoId, position));
  videoJobs.set(videoId, job);
  job.finally(() => { if (videoJobs.get(videoId) === job) videoJobs.delete(videoId); }).catch(() => {});
  return job;
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
          processedChunks: state.processedChunks,
          source: state.source,
          duration: state.duration,
        });
        break;
      }
      case 'analyzeAhead':
        sendResponse(await queueAnalysis(msg.videoId, msg.position));
        break;
      case 'transcribeChunk': {
        console.log(`[ytsb] sending chunk [${msg.chunkRange[0]}s-${msg.chunkRange[1]}s] to local Whisper server`);
        const segments = await transcribeAudio(msg.pcm, msg.sampleRate, msg.chunkRange[0]);
        console.log(`[ytsb] transcribed chunk [${msg.chunkRange[0]}s-${msg.chunkRange[1]}s]: ${segments.length} segment(s)`, segments);
        const state = await handleChunkProcessed(msg.videoId, msg.chunkRange, segments);
        sendResponse({ videoId: msg.videoId, chunkRange: msg.chunkRange, sponsorRanges: state.sponsorRanges });
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
  })().catch((err) => {
    console.error(`[ytsb] ${msg.type} failed:`, err.message);
    sendResponse({ error: err.message });
  });
  return true; // keep the message channel open for the async response
});
