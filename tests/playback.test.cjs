const assert = require('node:assert/strict');
const { test } = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const ytsbTimeline = require('../timeline');
const settle = () => new Promise(resolve => setImmediate(resolve));

async function player() {
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
  const context = vm.createContext({
    URL, AbortController, ytsbTimeline, location, Date: { now: () => clock },
    console: { log() {}, warn() {}, error() {} }, setInterval() {},
    document: {
      addEventListener() {},
      createElement() { assert.fail('No preparation overlay should be created'); },
      querySelector(selector) { return selector.includes('ad-showing') ? flags.ad : video; },
    },
    chrome: {
      runtime: {
        onMessage: { addListener() {} },
        async sendMessage(msg) {
          if (msg.type === 'getEnabled') return { enabled: true };
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
    tick() { vm.runInContext('tick()', context); },
    advance(ms) { clock += ms; },
    disable() { changed({ enabled: { newValue: false } }, 'local'); },
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

test('late results from a previous video cannot skip the new video', async () => {
  const app = await player();
  app.location.href = 'https://www.youtube.com/watch?v=abcdefghijk';
  app.tick();
  app.pending[0].resolve(analyzed([{ start: 0, end: 80 }]));
  await settle();
  assert.equal(app.video.currentTime, 10);
});
