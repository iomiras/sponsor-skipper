// Playback is independent of analysis. No MediaElementAudioSource or live tap.

const LOOKAHEAD_SECONDS = 120;
let videoId = null;
let video = null;
let state = { processedChunks: [], sponsorRanges: [] };
let settings = ytsbSettings.normalize(null);
let skipWidget = null;
let skipButton = null;
let autoSkipButton = null;
let generation = 0;
let busy = false;
let error = '';
let listeners = null;
let retryAt = 0;

function extractVideoId(url) {
  return new URL(url).searchParams.get('v');
}

async function message(body) {
  const response = await chrome.runtime.sendMessage(body);
  if (!response || response.error) throw new Error(response?.error || 'The background worker did not respond. Reload the extension and refresh this tab.');
  return response;
}

function isYouTubeAd() {
  return Boolean(document.querySelector('#movie_player.ad-showing, #movie_player.ad-interrupting'));
}

// Mirrors .ytp-ad-skip-button: flush to the right edge, sitting above the
// progress bar, so it reads as part of the player rather than an add-on.
const SKIP_WIDGET_STYLE = [
  'position:absolute', 'right:0', 'bottom:12%', 'z-index:2147483000',
  'margin:0', 'display:flex!important', 'flex-direction:column', 'align-items:flex-end', 'gap:4px',
  'visibility:visible!important', 'opacity:1!important',
].join(';');
const SKIP_BUTTON_STYLE = [
  'margin:0', 'padding:10px 16px',
  'font:500 14px/1 Roboto,Arial,system-ui,sans-serif',
  'color:#fff', 'background:rgba(0,0,0,.6)',
  'border:1px solid rgba(255,255,255,.3)', 'border-right:none',
  'border-radius:3px 0 0 3px', 'cursor:pointer', 'pointer-events:auto',
].join(';');
const AUTO_SKIP_BUTTON_STYLE = [
  'margin:0', 'padding:5px 12px',
  'font:400 12px/1 Roboto,Arial,system-ui,sans-serif',
  'color:#fff', 'background:rgba(0,0,0,.6)',
  'border:1px solid rgba(255,255,255,.3)', 'border-right:none',
  'border-radius:3px 0 0 3px', 'cursor:pointer', 'pointer-events:auto',
].join(';');

function doSkip(target) {
  if (!video || !Number.isFinite(target)) return;
  video.currentTime = target;
  hideSkipButton();
  tick();
}

// Built on demand: in auto mode the player is never touched, which keeps the
// overlay out of the way of anyone who just wants the skip to happen.
function showSkipButton(target) {
  if (!skipWidget) {
    const consumePlayerEvent = (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };

    skipWidget = document.createElement('div');
    skipWidget.id = 'ytsb-skip-widget';

    skipButton = document.createElement('button');
    skipButton.id = 'ytsb-skip-button';
    skipButton.type = 'button';
    skipButton.setAttribute('aria-label', 'Skip detected sponsor segment');
    skipButton.textContent = 'Skip sponsor ⏭';
    skipButton.addEventListener('pointerdown', consumePlayerEvent, true);
    skipButton.addEventListener('mousedown', consumePlayerEvent, true);
    skipButton.addEventListener('click', (event) => {
      consumePlayerEvent(event); // do not let YouTube's player surface handle it
      doSkip(Number(skipButton.dataset.target));
    });

    autoSkipButton = document.createElement('button');
    autoSkipButton.id = 'ytsb-auto-skip-button';
    autoSkipButton.type = 'button';
    autoSkipButton.setAttribute('aria-label', 'Skip sponsor segments automatically from now on');
    autoSkipButton.textContent = 'Skip automatically from now on';
    autoSkipButton.addEventListener('pointerdown', consumePlayerEvent, true);
    autoSkipButton.addEventListener('mousedown', consumePlayerEvent, true);
    autoSkipButton.addEventListener('click', (event) => {
      consumePlayerEvent(event);
      const to = Number(skipButton.dataset.target);
      message({ type: 'setSettings', settings: { skipMode: 'auto' } })
        .then((next) => { settings = ytsbSettings.normalize(next); })
        .catch((err) => console.error('[ytsb] setSettings failed:', err.message));
      doSkip(to);
    });

    skipWidget.appendChild(skipButton);
    skipWidget.appendChild(autoSkipButton);
  }
  skipButton.dataset.target = String(target);
  // The player re-renders on navigation, so re-attach rather than assuming.
  const host = document.querySelector('.html5-video-player') || document.querySelector('#movie_player');
  if (!host) {
    hideSkipButton();
    return;
  }
  if (skipWidget.parentElement !== host) host.appendChild(skipWidget);
  // Written every time, and as display rather than [hidden]: any YouTube rule
  // setting display on a player descendant would override the hidden attribute.
  skipWidget.style.cssText = `${SKIP_WIDGET_STYLE};display:flex`;
  skipButton.style.cssText = SKIP_BUTTON_STYLE;
  autoSkipButton.style.cssText = AUTO_SKIP_BUTTON_STYLE;
}

function hideSkipButton() {
  if (skipWidget) skipWidget.style.cssText = `${SKIP_WIDGET_STYLE};display:none!important`;
}

function reconcilePlayback() {
  if (!video || !videoId || !settings.enabled || isYouTubeAd()) {
    hideSkipButton();
    return;
  }
  const time = video.currentTime;
  const ranges = ytsbSettings.actionableRanges(state.sponsorRanges, settings);
  const target = Math.min(state.duration || Infinity, ytsbTimeline.skipTarget(ranges, time));
  if (target <= time) {
    hideSkipButton();
    return;
  }
  if (settings.skipMode === 'manual') {
    showSkipButton(target);
    return;
  }
  video.currentTime = target;
}

function resetVideo(id) {
  generation++;
  videoId = id;
  busy = false;
  error = '';
  retryAt = 0;
  state = { processedChunks: [], sponsorRanges: [] };
  const currentGeneration = generation;
  if (id) message({ type: 'getState', videoId: id }).then((cached) => {
    if (currentGeneration !== generation) return;
    if (!state.duration) state = cached;
    reconcilePlayback();
  }).catch((err) => {
    if (currentGeneration === generation) console.error('[ytsb] could not load cached analysis:', err.message);
  });
}

function attachVideo(element) {
  listeners?.abort();
  video = element;
  listeners = new AbortController();
  const options = { signal: listeners.signal };
  for (const event of ['play', 'seeking', 'timeupdate', 'loadedmetadata', 'ratechange']) video.addEventListener(event, tick, options);
  reconcilePlayback();
}

function tick() {
  const id = extractVideoId(location.href);
  if (id !== videoId) resetVideo(id);
  const element = document.querySelector('video.html5-main-video') || document.querySelector('#movie_player video');
  if (element && element !== video) attachVideo(element);
  if (!id || !video) return;
  reconcilePlayback();
  if (!settings.enabled || busy || Date.now() < retryAt || isYouTubeAd() || video.seeking) return;
  const position = video.currentTime;
  if (state.duration && ytsbTimeline.checkedEnd(state.processedChunks, position) >= Math.min(state.duration, position + LOOKAHEAD_SECONDS)) return;
  busy = true;
  error = '';
  const currentGeneration = generation;
  message({ type: 'analyzeAhead', videoId: id, position }).then((result) => {
    if (currentGeneration !== generation) return;
    state = result;
  }).catch((err) => {
    if (currentGeneration !== generation) return;
    error = err.message;
    retryAt = Date.now() + 30000;
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
  if (msg.type === 'getPlaybackStatus') sendResponse({ videoId, position: video?.currentTime || 0, analyzing: busy, error, source: state.source });
});
chrome.storage.onChanged.addListener((changes, area) => {
  const change = area === 'local' && changes[ytsbSettings.SETTINGS_KEY];
  if (change) { settings = ytsbSettings.normalize(change.newValue); tick(); }
});
message({ type: 'getSettings' }).then((result) => { settings = ytsbSettings.normalize(result); tick(); }).catch((err) => { error = err.message; });
document.addEventListener('yt-navigate-finish', tick);
setInterval(tick, 250);
