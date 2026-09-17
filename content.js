// Playback is independent of analysis. No MediaElementAudioSource or live tap.
console.log('[ytsb] caption-first player controller loaded');

const LOOKAHEAD_SECONDS = 120;
let videoId = null;
let video = null;
let state = { processedChunks: [], sponsorRanges: [] };
let enabled = true;
let bypass = false;
let generation = 0;
let busy = false;
let error = '';
let held = false;
let wantsPlay = false;
let listeners = null;
let panel = null;
let statusText = null;
let retryButton = null;

function extractVideoId(url) {
  return new URL(url).searchParams.get('v');
}

async function message(body) {
  const response = await chrome.runtime.sendMessage(body);
  if (!response || response.error) throw new Error(response?.error || 'The background worker did not respond. Reload the extension and refresh this tab.');
  return response;
}

function showStatus(text, failed = false) {
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'ytsb-preparation';
    panel.setAttribute('role', 'status');
    Object.assign(panel.style, {
      position: 'fixed', bottom: '24px', left: '24px', zIndex: '2147483647',
      padding: '16px', maxWidth: '420px', background: '#181818', color: '#fff',
      border: '1px solid #555', borderRadius: '12px', font: '14px/1.5 system-ui',
      boxShadow: '0 4px 24px #0008',
    });
    statusText = document.createElement('div');
    const actions = document.createElement('div');
    actions.style.marginTop = '10px';
    retryButton = document.createElement('button');
    retryButton.textContent = 'Retry';
    retryButton.addEventListener('click', () => { error = ''; bypass = false; tick(); });
    const continueButton = document.createElement('button');
    continueButton.textContent = 'Continue without skipping';
    continueButton.addEventListener('click', () => {
      bypass = true;
      hideStatus();
      releasePlayback();
    });
    for (const button of [retryButton, continueButton]) {
      Object.assign(button.style, { padding: '6px 10px', marginRight: '8px', cursor: 'pointer', borderRadius: '6px', border: '1px solid #777', background: '#303030', color: '#fff', font: 'inherit' });
      actions.appendChild(button);
    }
    panel.append(statusText, actions);
  }
  if (!panel.isConnected) (document.fullscreenElement || document.body || document.documentElement).appendChild(panel);
  statusText.textContent = text;
  retryButton.hidden = !failed;
  panel.hidden = false;
}

function hideStatus() {
  if (panel) panel.hidden = true;
}

function holdPlayback() {
  if (!video.paused) wantsPlay = true;
  held = true;
  if (!video.paused) video.pause();
  showStatus(error ? `Sponsor analysis unavailable: ${error}` : 'Preparing sponsor skips… Checking the next section.', Boolean(error));
}

function releasePlayback() {
  const resume = held && wantsPlay;
  held = false;
  hideStatus();
  if (resume && video?.paused) video.play().catch((err) => console.log('[ytsb] ready; press Play to continue:', err.message));
}

function isYouTubeAd() {
  return Boolean(document.querySelector('#movie_player.ad-showing, #movie_player.ad-interrupting'));
}

function reconcilePlayback() {
  if (!video || !videoId) return;
  if (!enabled || bypass || isYouTubeAd()) { releasePlayback(); return; }
  const time = video.currentTime;
  const checked = ytsbTimeline.checkedEnd(state.processedChunks, time);
  const target = Math.min(state.duration || Infinity, ytsbTimeline.skipTarget(state.sponsorRanges, time));
  const required = Math.min(state.duration || Infinity, target + 3);
  if (checked + 0.001 < required) { holdPlayback(); return; }
  if (target > time) {
    console.log(`[ytsb] skipping sponsor [${time.toFixed(2)}s-${target.toFixed(2)}s] before playback`);
    video.currentTime = target;
  }
  releasePlayback();
}

function resetVideo(id) {
  generation++;
  videoId = id;
  busy = false;
  bypass = false;
  error = '';
  state = { processedChunks: [], sponsorRanges: [] };
  hideStatus();
  const currentGeneration = generation;
  if (id) message({ type: 'getState', videoId: id }).then((cached) => {
    if (currentGeneration !== generation) return;
    if (!state.duration) state = cached;
    reconcilePlayback();
  }).catch((err) => {
    if (currentGeneration === generation) { error = err.message; reconcilePlayback(); }
  });
}

function attachVideo(element) {
  listeners?.abort();
  video = element;
  held = false;
  wantsPlay = !video.paused;
  listeners = new AbortController();
  const options = { signal: listeners.signal };
  video.addEventListener('play', () => { wantsPlay = true; reconcilePlayback(); }, options);
  video.addEventListener('pause', () => { if (!held) wantsPlay = false; }, options);
  for (const event of ['seeking', 'timeupdate', 'loadedmetadata', 'ratechange']) video.addEventListener(event, tick, options);
  reconcilePlayback();
}

function tick() {
  const id = extractVideoId(location.href);
  if (id !== videoId) resetVideo(id);
  const element = document.querySelector('video.html5-main-video') || document.querySelector('#movie_player video');
  if (element && element !== video) attachVideo(element);
  if (!id || !video) { hideStatus(); return; }
  reconcilePlayback();
  if (!enabled || bypass || busy || error || isYouTubeAd() || video.seeking) return;
  const position = video.currentTime;
  if (state.duration && ytsbTimeline.checkedEnd(state.processedChunks, position) >= Math.min(state.duration, position + LOOKAHEAD_SECONDS)) return;
  busy = true;
  const currentGeneration = generation;
  console.log(`[ytsb] analyzing ahead: video=${id}, position=${position.toFixed(2)}s`);
  message({ type: 'analyzeAhead', videoId: id, position }).then((result) => {
    if (currentGeneration !== generation) return;
    state = result;
    console.log(`[ytsb] source=${state.source}, checked ranges:`, state.processedChunks, 'sponsors:', state.sponsorRanges);
  }).catch((err) => {
    if (currentGeneration !== generation) return;
    error = err.message;
    console.error('[ytsb] advance analysis failed:', error);
  }).finally(() => {
    if (currentGeneration !== generation) return;
    busy = false;
    reconcilePlayback();
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'seekTo' && video) { video.currentTime = msg.time; tick(); sendResponse({ ok: true }); }
  if (msg.type === 'getCurrentVideoId') sendResponse({ videoId });
  if (msg.type === 'getPlaybackStatus') sendResponse({ videoId, position: video?.currentTime || 0, held, error, bypass, source: state.source });
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.enabled) { enabled = changes.enabled.newValue; tick(); }
});
message({ type: 'getEnabled' }).then((result) => { enabled = result.enabled; tick(); }).catch((err) => { error = err.message; });
document.addEventListener('yt-navigate-finish', tick);
document.addEventListener('fullscreenchange', () => { if (panel) (document.fullscreenElement || document.body).appendChild(panel); });
setInterval(tick, 250);
