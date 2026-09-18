const assert = require('node:assert/strict');
const { test } = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const ytsbTimeline = require('../timeline');
const ytsbSettings = require('../settings');
const settle = () => new Promise(resolve => setImmediate(resolve));

async function player(overrides = {}) {
  const pending = [];
  let changed;
  let clock = 0;
  const location = { href: 'https://www.youtube.com/watch?v=AI4Ivk5AoZ8' };
  const video = {
    currentTime: 10, paused: false, seeking: false, addEventListener() {},
    pause() { assert.fail('Analysis must never pause playback'); },
    play() { assert.fail('Analysis must never start playback'); },
  };
  const flags = { ad: false };
  const host = { children: [], appendChild(element) { host.children.push(element); element.parentElement = host; } };
  const context = vm.createContext({
    URL, AbortController, ytsbTimeline, ytsbSettings, location, Date: { now: () => clock },
    console: { log() {}, warn() {}, error() {} }, setInterval() {},
    document: {
      addEventListener() {},
      createElement(tag) {
        // Auto mode must leave the player untouched; only manual mode may build UI.
        if (!overrides.allowOverlay) assert.fail('No overlay should be created in auto mode');
        const element = {
          tagName: tag, style: {}, dataset: {}, hidden: false, handlers: {},
          addEventListener(type, fn) { element.handlers[type] = fn; },
          click() { element.handlers.click?.(); },
        };
        return element;
      },
      querySelector(selector) {
        if (selector.includes('ad-showing')) return flags.ad;
        if (selector === '#movie_player') return host;
        return video;
      },
    },
    chrome: {
      runtime: {
        onMessage: { addListener() {} },
        async sendMessage(msg) {
          if (msg.type === 'getSettings') return ytsbSettings.normalize(overrides.settings);
          if (msg.type === 'getState') return { processedChunks: [], sponsorRanges: [] };
          return new Promise((resolve, reject) => pending.push({ msg, resolve, reject }));
        },
      },
      storage: { onChanged: { addListener(fn) { changed = fn; } } },
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../content.js'), 'utf8'), context);
  await settle();
  return {
    video, flags, location, pending,
    button: () => host.children[0],
    tick() { vm.runInContext('tick()', context); },
    advance(ms) { clock += ms; },
    apply(patch) { changed({ [ytsbSettings.SETTINGS_KEY]: { newValue: ytsbSettings.normalize(patch) } }, 'local'); },
    disable() { changed({ [ytsbSettings.SETTINGS_KEY]: { newValue: { enabled: false } } }, 'local'); },
  };
}

function analyzed(sponsorRanges) {
  return { source: 'captions', duration: 300, processedChunks: [[10, 60]], sponsorRanges };
}

test('pending analysis and seeks never interrupt viewing or create an overlay', async () => {
  const app = await player();
  assert.equal(app.pending.length, 1);
  app.video.currentTime = 150;
  app.tick();
  assert.equal(app.video.currentTime, 150);
  assert.equal(app.video.paused, false);
});

test('late sponsor result skips immediately even when the landing point is unchecked', async () => {
  const app = await player();
  app.video.currentTime = 50;
  app.pending[0].resolve(analyzed([{ start: 40, end: 80 }]));
  await settle();
  assert.equal(app.video.currentTime, 80);
  assert.equal(app.video.paused, false);
});

test('completed sponsor ranges never rewind and manual pause is preserved', async () => {
  const app = await player();
  app.video.currentTime = 90;
  app.video.paused = true;
  app.pending[0].resolve(analyzed([{ start: 40, end: 80 }]));
  await settle();
  assert.equal(app.video.currentTime, 90);
  assert.equal(app.video.paused, true);
});

test('analysis errors retry after 30 seconds without pausing', async () => {
  const app = await player();
  app.pending[0].reject(new Error('Server unavailable'));
  await settle();
  app.tick();
  assert.equal(app.pending.length, 1);
  app.advance(30000);
  app.tick();
  assert.equal(app.pending.length, 2);
  assert.equal(app.video.paused, false);
});

test('disabled extension and YouTube ads suppress sponsor skips', async () => {
  for (const disable of [false, true]) {
    const app = await player();
    if (disable) app.disable();
    else app.flags.ad = true;
    app.pending[0].resolve(analyzed([{ start: 0, end: 80 }]));
    await settle();
    assert.equal(app.video.currentTime, 10);
  }
});

test('manual mode offers a skip button instead of seeking, and the click skips', async () => {
  const app = await player({ settings: { skipMode: 'manual' }, allowOverlay: true });
  app.pending[0].resolve(analyzed([{ start: 5, end: 80 }]));
  await settle();
  assert.equal(app.video.currentTime, 10, 'manual mode must not move playback on its own');
  const button = app.button();
  assert.ok(button, 'expected a skip button on the player');
  assert.equal(button.hidden, false);
  button.click();
  assert.equal(app.video.currentTime, 80);
  assert.equal(button.hidden, true, 'button should disappear once the skip happened');
});

test('the manual button disappears once playback leaves the sponsor range', async () => {
  const app = await player({ settings: { skipMode: 'manual' }, allowOverlay: true });
  app.pending[0].resolve(analyzed([{ start: 5, end: 20 }]));
  await settle();
  assert.equal(app.button().hidden, false);
  app.video.currentTime = 25;
  app.tick();
  assert.equal(app.button().hidden, true);
});

test('segments shorter than the minimum are reported but never skipped', async () => {
  const app = await player({ settings: { minSkipSeconds: 5 } });
  app.pending[0].resolve(analyzed([{ start: 8, end: 11 }]));
  await settle();
  assert.equal(app.video.currentTime, 10, 'a 3s detection is below the 5s minimum');
});

test('late results from a previous video cannot skip the new video', async () => {
  const app = await player();
  app.location.href = 'https://www.youtube.com/watch?v=abcdefghijk';
  app.tick();
  app.pending[0].resolve(analyzed([{ start: 0, end: 80 }]));
  await settle();
  assert.equal(app.video.currentTime, 10);
});
