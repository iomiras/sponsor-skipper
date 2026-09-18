importScripts('timeline.js', 'settings.js');

// MV3 service worker: sole owner of chrome.storage.local and the local server calls
// (both /transcribe and /classify - the only file that talks to localhost:8787).
// Message contract:
//   content.js -> here: { type: 'getState', videoId } -> VideoState
//   content.js -> here: { type: 'transcribeChunk', videoId, chunkRange, pcm: base64, sampleRate }
//                        -> { videoId, chunkRange, sponsorRanges } (via sendResponse, once
//                           transcription + classification finish - not a push message)
//   any page    -> here: { type: 'getSettings' } -> Settings
//   any page    -> here: { type: 'setSettings', settings } -> merged Settings

const TRANSCRIBE_URL = 'http://localhost:8787/transcribe';
const PROXY_URL = 'http://localhost:8787/classify';
const NOUL_THRESHOLD = 0.6; // starting default, tune via testing
const MERGE_GAP_SECONDS = 15;
const RANGE_BUFFER_SECONDS = 2;
const CLASSIFY_BATCH_SIZE = 40;
// Refinement walks short non-overlapping word windows across the transition.
// Overlapping or longer windows report a hit anywhere inside themselves, which
// drags the boundary outward by the window length and skips real content.
const REFINE_WINDOW_WORDS = 3;
// A window ends a beat after its last word, not at the next word: a long pause
// after the read would otherwise pull the skip into the content that follows.
const WORD_TAIL_SECONDS = 0.6;
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

async function getSettings() {
  const stored = await chrome.storage.local.get(ytsbSettings.SETTINGS_KEY);
  return ytsbSettings.normalize(stored[ytsbSettings.SETTINGS_KEY]);
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

// Jev is cheap per question but a whole video is hundreds of them, so they go
// out in bounded batches rather than one request the server has to hold open.
async function classifySegments(segments) {
  const results = {};
  for (let i = 0; i < segments.length; i += CLASSIFY_BATCH_SIZE) {
    const batch = segments.slice(i, i + CLASSIFY_BATCH_SIZE);
    Object.assign(results, await classifyBatch(batch));
  }
  return results;
}

async function classifyBatch(segments) {
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

// Consecutive flagged caption segments (allowing a short gap of unflagged ones)
// form one sponsor read, kept as index runs so refinement can look at neighbours.
function mergeRuns(segments, flagged) {
  const runs = [];
  for (let i = 0; i < segments.length; i++) {
    if (!flagged.has(segments[i].id)) continue;
    const last = runs.at(-1);
    if (last && segments[i].start - segments[last.lastIndex].end <= MERGE_GAP_SECONDS) {
      last.lastIndex = i;
    } else {
      runs.push({ firstIndex: i, lastIndex: i });
    }
  }
  return runs;
}

function clamp(value, low, high) {
  return Math.min(Math.max(value, low), high);
}

function wordsBetween(segments, fromIndex, toIndex) {
  const words = [];
  for (let i = Math.max(0, fromIndex); i <= Math.min(segments.length - 1, toIndex); i++) {
    words.push(...(segments[i].words || []));
  }
  return words;
}

function buildWindows(words, id) {
  const windows = [];
  const all = words.map((word) => word.text).join(' ');
  for (let i = 0; i < words.length; i += REFINE_WINDOW_WORDS) {
    const slice = words.slice(i, i + REFINE_WINDOW_WORDS);
    if (!slice.length) break;
    const tail = slice.at(-1).start + WORD_TAIL_SECONDS;
    const next = words[i + slice.length]?.start;
    windows.push({
      id: `${id}-${i}`,
      start: slice[0].start,
      end: next === undefined ? tail : Math.min(next, tail),
      text: slice.map((word) => word.text).join(' '),
      // three words alone are ambiguous, so the surrounding speech is the context.
      context: all,
    });
  }
  return windows;
}

// Pass 2. The coarse pass only knows which caption blocks are sponsor, and a
// block can be 15s long, so the read's real edge is found by classifying short
// word windows across the transition on either side.
async function refineRuns(runs, segments) {
  const plans = runs.map((run, index) => {
    const startWords = wordsBetween(segments, run.firstIndex - 1, run.firstIndex);
    const endWords = wordsBetween(segments, run.lastIndex, run.lastIndex + 1);
    return {
      run,
      startWindows: buildWindows(startWords, `run${index}-start`),
      endWindows: buildWindows(endWords, `run${index}-end`),
    };
  });

  const all = plans.flatMap((plan) => [...plan.startWindows, ...plan.endWindows]);
  const results = all.length ? await classifySegments(all) : {};

  return plans.map(({ run, startWindows, endWindows }) => {
    const coarseStart = segments[run.firstIndex].start;
    const coarseEnd = segments[run.lastIndex].end;
    const isSponsor = (window) => (results[window.id]?.noul ?? 0) >= NOUL_THRESHOLD;

    const firstSponsor = startWindows.find(isSponsor);
    const lastSponsor = [...endWindows].reverse().find(isSponsor);
    // The refined edge is the point of the whole pass, so it wins over the
    // caption-block edge in both directions; the neighbours only bound it.
    const earliest = segments[run.firstIndex - 1]?.start ?? coarseStart;
    const latest = segments[run.lastIndex + 1]?.end ?? coarseEnd;
    const start = clamp(firstSponsor ? firstSponsor.start : coarseStart, earliest, coarseEnd);
    const end = clamp(lastSponsor ? lastSponsor.end : coarseEnd, coarseStart, latest);

    console.log(`[ytsb] refined sponsor [${coarseStart.toFixed(1)}s-${coarseEnd.toFixed(1)}s] -> [${start.toFixed(1)}s-${end.toFixed(1)}s]`);
    // No outward padding: word timings are exact, and erring outward cuts content.
    return { start: Math.max(0, start), end: Math.max(start + 1, end) };
  });
}

// Captions for the whole video are already downloaded by prepare-video, so the
// coarse pass covers every segment at once instead of one window per request.
async function analyzeCaptions(videoId, prepared) {
  const segments = prepared.segments;
  const withContext = segments.map((seg, i) => ({
    ...seg,
    context: [segments[i - 1]?.text, segments[i + 1]?.text].filter(Boolean).join(' / '),
  }));
  console.log(`[ytsb] video=${videoId} classifying all ${segments.length} caption segment(s)`);
  const results = await classifySegments(withContext);

  const flagged = new Set();
  for (const seg of segments) {
    const noul = results[seg.id]?.noul;
    if (!Number.isFinite(noul) || noul < 0 || noul > 1) throw new Error(`Missing or invalid classifier score for ${seg.id}`);
    if (noul >= NOUL_THRESHOLD) flagged.add(seg.id);
  }

  const runs = mergeRuns(segments, flagged);
  console.log(`[ytsb] video=${videoId} ${flagged.size} flagged segment(s) forming ${runs.length} sponsor run(s)`);
  const sponsorRanges = await refineRuns(runs, segments);

  const state = {
    ...(await getState(videoId)),
    duration: prepared.duration,
    source: prepared.source,
    language: prepared.language,
    processedChunks: [[0, prepared.duration]],
    candidateSegments: segments
      .filter((seg) => flagged.has(seg.id))
      .map((seg) => ({ id: seg.id, start: seg.start, end: seg.end, text: seg.text, confidence: results[seg.id].noul })),
    sponsorRanges,
  };
  console.log(`[ytsb] video=${videoId} sponsor ranges:`, sponsorRanges);
  await setState(videoId, state);
  return state;
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
  if (prepared.source === 'captions') return analyzeCaptions(videoId, prepared);
  // Whisper still costs real time per range, so audio stays windowed ahead of playback.
  const range = ytsbTimeline.nextRange(state.processedChunks, position, prepared.duration, 30);
  if (!range) return state;
  const { segments } = await serverRequest('transcribe-video', { videoId, start: range[0], end: range[1] });
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
        sendResponse({
          settings: await getSettings(),
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
      case 'getSettings':
        sendResponse(await getSettings());
        break;
      case 'setSettings': {
        // Merged, so a page that only knows about one field cannot drop the rest.
        const next = ytsbSettings.normalize({ ...(await getSettings()), ...msg.settings });
        await chrome.storage.local.set({ [ytsbSettings.SETTINGS_KEY]: next });
        sendResponse(next);
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
