// Content script world. Transcription runs server-side (background.js posts
// audio to the local server), not in-page: youtube.com's CSP has no
// worker-src directive and falls back to script-src, which blocked every
// in-browser attempt at running a Worker here (chrome-extension:// URL, blob:
// URL, and an offscreen document all hit this before the move to the server).

console.log('[ytsb] content.js loaded');

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
  workerBacklog = 0; // in-flight chunks from the previous video will be dropped on videoId mismatch, not decremented
}

function setupAudioTap() {
  try {
    audioCtx = new AudioContext();
    sourceNode = audioCtx.createMediaElementSource(video);
  } catch (err) {
    // another extension may already hold a MediaElementSourceNode on this <video>;
    // a media element can only ever be connected to one.
    console.error('[ytsb] failed to tap video audio:', err.message);
    return;
  }
  sourceNode.connect(audioCtx.destination);

  captureNode = audioCtx.createScriptProcessor(4096, 1, 1);
  sourceNode.connect(captureNode);
  captureNode.connect(audioCtx.destination);

  captureStart = video.currentTime;
  captureBuffer = [];

  console.log(`[ytsb] audio tap built, context ${audioCtx.state} @ ${audioCtx.sampleRate}Hz`);
  // a context created outside a user gesture starts suspended, and a suspended
  // context never fires onaudioprocess.
  if (audioCtx.state === 'suspended') {
    audioCtx.resume().then(
      () => console.log('[ytsb] context resumed:', audioCtx.state),
      (err) => console.warn('[ytsb] context resume rejected, waiting for a click:', err.message)
    );
    document.addEventListener('click', () => audioCtx.resume(), { once: true });
  }

  let peak = 0;
  let callbacks = 0;
  captureNode.onaudioprocess = (e) => {
    callbacks += 1;
    const samples = e.inputBuffer.getChannelData(0);
    for (let i = 0; i < samples.length; i += 64) {
      const level = Math.abs(samples[i]);
      if (level > peak) peak = level;
    }
    if (video.paused) return;
    if (!shouldBeCapturing()) return;
    captureBuffer.push(new Float32Array(samples));

    if (captureBuffer.length * 4096 / audioCtx.sampleRate >= CHUNK_SECONDS) {
      finalizeChunk();
    }
  };

  // one line carrying every variable that can stall capture, so a stall is
  // diagnosable from a single log rather than by elimination.
  setInterval(() => {
    const buffered = captureBuffer.length * 4096 / audioCtx.sampleRate;
    console.log(
      `[ytsb] tap: ctx=${audioCtx.state} paused=${video.paused} readyState=${video.readyState}` +
      ` buffered=${buffered.toFixed(1)}s/${CHUNK_SECONDS}s peak=${peak.toFixed(4)} cbs=${callbacks}` +
      ` t=${video.currentTime.toFixed(0)} processedUpTo=${processedUpTo.toFixed(0)} backlog=${workerBacklog} enabled=${enabled}`
    );
    peak = 0;
    callbacks = 0;
  }, 5000);
}

function shouldBeCapturing() {
  return enabled && processedUpTo < video.currentTime + LOOKAHEAD_SECONDS && workerBacklog < MAX_WORKER_BACKLOG;
}

function finalizeChunk() {
  const start = captureStart;
  const end = start + CHUNK_SECONDS;
  const pcm = flattenBuffer(captureBuffer);
  captureBuffer = [];
  captureStart = end;
  console.log(`[ytsb] chunk captured [${start}s-${end}s], sending for transcription`);

  workerBacklog += 1;
  chrome.runtime.sendMessage(
    { type: 'transcribeChunk', videoId, chunkRange: [start, end], pcm, sampleRate: audioCtx.sampleRate },
    (res) => {
      workerBacklog = Math.max(0, workerBacklog - 1);
      if (!res || res.videoId !== videoId) return; // stale response after navigating to a different video
      sponsorRanges = res.sponsorRanges;
      console.log(`[ytsb] chunk [${res.chunkRange[0]}s-${res.chunkRange[1]}s] classified, sponsor ranges now:`, sponsorRanges);
    }
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

function startAudioTap() {
  if (!audioCtx) setupAudioTap();
  else audioCtx.resume();
}

function attachToVideo(v) {
  video = v;
  console.log('[ytsb] attached to video element, paused =', v.paused);
  video.addEventListener('timeupdate', onTimeUpdate);
  video.addEventListener('play', () => {
    console.log('[ytsb] play event, starting audio tap');
    startAudioTap();
  });
  video.addEventListener('pause', () => {
    // stop requesting new chunks; ScriptProcessor stays connected but shouldBeCapturing gates on video.paused
  });
  // the video is usually already playing by the time we attach (autoplay, or a ?t= deep link),
  // so its 'play' event has already fired and will not fire again.
  if (!v.paused) {
    console.log('[ytsb] video already playing at attach, starting audio tap');
    startAudioTap();
  }
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
