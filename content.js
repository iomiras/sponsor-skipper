// Content script world. A Worker needs a window/DOM context to construct,
// which a MV3 service worker does not have, so STT must run from here.

const LOOKAHEAD_SECONDS = 90;
const CHUNK_SECONDS = 30;
const MAX_WORKER_BACKLOG = 2; // caps in-flight chunks so capture doesn't outrun a slow transcriber

let videoId = null;
let video = null;
let processedUpTo = 0;
let sponsorRanges = [];
let skippedThisSession = new Set();
let enabled = true;

chrome.runtime.sendMessage({ type: 'getEnabled' }, (res) => {
  if (res) enabled = res.enabled;
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && 'enabled' in changes) enabled = changes.enabled.newValue;
});

let audioCtx = null;
let sourceNode = null;
let captureNode = null;
let captureBuffer = [];
let captureStart = 0;
let workerBacklog = 0;

let worker = null;

// Constructing a Worker directly off a chrome-extension:// URL can still throw
// SecurityError from a content script even when web_accessible_resources lists
// it, so fetch the source and spawn from a same-origin blob: URL instead.
async function initWorker() {
  const src = await fetch(chrome.runtime.getURL('worker.js')).then((r) => r.text());
  const blobUrl = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
  worker = new Worker(blobUrl, { type: 'module' });

  worker.onmessage = (e) => {
    const { type, chunkRange, segments } = e.data;
    if (type !== 'chunkResult') return;
    workerBacklog = Math.max(0, workerBacklog - 1);
    console.log(`[ytsb] transcribed chunk [${chunkRange[0]}s-${chunkRange[1]}s]: ${segments.length} segment(s)`, segments);
    chrome.runtime.sendMessage(
      { type: 'chunkProcessed', videoId, chunkRange, segments },
      (state) => {
        if (state) {
          sponsorRanges = state.sponsorRanges;
          console.log('[ytsb] sponsor ranges now:', sponsorRanges);
        }
      }
    );
  };
  console.log('[ytsb] worker ready');
}
initWorker();

function extractVideoId(url) {
  const match = url.match(/[?&]v=([^&]+)/);
  return match ? match[1] : null;
}

function boundaryFromProcessedChunks(processedChunks) {
  let end = 0;
  const sorted = [...processedChunks].sort((a, b) => a[0] - b[0]);
  for (const [start, stop] of sorted) {
    if (start > end) break;
    end = Math.max(end, stop);
  }
  return end;
}

async function loadVideoState() {
  const state = await chrome.runtime.sendMessage({ type: 'getState', videoId });
  processedUpTo = boundaryFromProcessedChunks(state.processedChunks);
  sponsorRanges = state.sponsorRanges;
  skippedThisSession = new Set();
}

function setupAudioTap() {
  audioCtx = new AudioContext();
  sourceNode = audioCtx.createMediaElementSource(video);
  sourceNode.connect(audioCtx.destination);

  captureNode = audioCtx.createScriptProcessor(4096, 1, 1);
  sourceNode.connect(captureNode);
  captureNode.connect(audioCtx.destination);

  captureStart = video.currentTime;
  captureBuffer = [];

  captureNode.onaudioprocess = (e) => {
    if (video.paused) return;
    if (!shouldBeCapturing()) return;
    captureBuffer.push(new Float32Array(e.inputBuffer.getChannelData(0)));

    const capturedSeconds = captureBuffer.length * 4096 / audioCtx.sampleRate;
    if (capturedSeconds >= CHUNK_SECONDS) {
      finalizeChunk();
    }
  };
}

function shouldBeCapturing() {
  return enabled && worker && processedUpTo < video.currentTime + LOOKAHEAD_SECONDS && workerBacklog < MAX_WORKER_BACKLOG;
}

function finalizeChunk() {
  const start = captureStart;
  const end = start + CHUNK_SECONDS;
  const pcm = flattenBuffer(captureBuffer);
  captureBuffer = [];
  captureStart = end;
  console.log(`[ytsb] chunk captured [${start}s-${end}s], sending to worker for transcription`);

  workerBacklog += 1;
  worker.postMessage(
    { type: 'transcribeChunk', videoId, chunkRange: [start, end], pcm, sampleRate: audioCtx.sampleRate },
    [pcm.buffer]
  );
  processedUpTo = Math.max(processedUpTo, end);
}

function flattenBuffer(chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function checkSponsorSkip() {
  if (!enabled) return;
  for (const range of sponsorRanges) {
    const key = `${range.start}-${range.end}`;
    if (video.currentTime >= range.start && video.currentTime < range.end && !skippedThisSession.has(key)) {
      skippedThisSession.add(key);
      video.currentTime = range.end;
      return;
    }
  }
}

function handleSeek() {
  if (Math.abs(video.currentTime - captureStart) > LOOKAHEAD_SECONDS) {
    processedUpTo = Math.max(processedUpTo, video.currentTime);
    captureStart = video.currentTime;
    captureBuffer = [];
  }
}

let lastTime = -1;
function onTimeUpdate() {
  checkSponsorSkip();
  if (Math.abs(video.currentTime - lastTime) > 2) handleSeek();
  lastTime = video.currentTime;
}

function attachToVideo(v) {
  video = v;
  video.addEventListener('timeupdate', onTimeUpdate);
  video.addEventListener('play', () => {
    if (!audioCtx) setupAudioTap();
    else audioCtx.resume();
  });
  video.addEventListener('pause', () => {
    // stop requesting new chunks; ScriptProcessor stays connected but shouldBeCapturing gates on video.paused
  });
}

function onNavigate() {
  const id = extractVideoId(location.href);
  if (!id || id === videoId) return;
  videoId = id;
  loadVideoState();
}

function waitForVideoElement() {
  // .html5-main-video: the watch page can have a second hidden <video> (autoplay-next preview, Shorts shelf tile)
  const v = document.querySelector('video.html5-main-video') || document.querySelector('#movie_player video');
  if (v && v !== video) {
    attachToVideo(v);
  }
  if (!videoId) onNavigate();
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'seekTo' && video) {
    video.currentTime = msg.time;
    sendResponse({ ok: true });
  }
  if (msg.type === 'getCurrentVideoId') {
    sendResponse({ videoId });
  }
});

document.addEventListener('yt-navigate-finish', onNavigate);
setInterval(waitForVideoElement, 1000);
onNavigate();
