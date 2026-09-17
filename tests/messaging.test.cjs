const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const timeline = require('../timeline');
const VIDEO = 'AI4Ivk5AoZ8';

function harness(fetch) {
  let listener;
  const saved = {};
  const context = vm.createContext({
    fetch, console: { log() {}, warn() {}, error() {} }, setTimeout,
    importScripts() {}, ytsbTimeline: timeline,
    chrome: {
      runtime: { onMessage: { addListener(fn) { listener = fn; } } },
      storage: { local: {
        async get(key) { return structuredClone({ [key]: saved[key] }); },
        async set(value) { Object.assign(saved, structuredClone(value)); },
      } },
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../background.js'), 'utf8'), context);
  return { saved, send: (msg) => new Promise(resolve => listener(msg, {}, resolve)) };
}
const ok = (body) => ({ ok: true, json: async () => body });

function captionServer(calls, results = { s1: { noul: 0.95 }, s2: { noul: 0.1 } }) {
  return async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, body });
    if (url.endsWith('/prepare-video')) return ok({ source: 'captions', duration: 1800, language: 'en', segments: [
      { id: 's0', start: 990, end: 999, text: 'Here is a drink for the outdoors.' },
      { id: 's1', start: 1000, end: 1005, text: 'Look for Mountain Dew in stores near you.' },
      { id: 's2', start: 1006, end: 1010, text: 'Now back to our hike.' },
    ] });
    if (url.endsWith('/classify')) return ok({ results });
    assert.fail(`Captions must not use audio or Whisper: ${url}`);
  };
}

test('caption analysis runs ahead at a deep link without audio and includes adjacent context', async () => {
  const calls = [];
  const app = harness(captionServer(calls));
  const state = await app.send({ type: 'analyzeAhead', videoId: VIDEO, position: 1000 });
  assert.equal(state.error, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(state.processedChunks)), [[1000, 1060]]);
  assert.deepEqual(JSON.parse(JSON.stringify(state.sponsorRanges)), [{ start: 998, end: 1007 }]);
  const classified = calls.find(c => c.url.endsWith('/classify')).body.segments;
  assert.equal(classified.length, 2);
  assert.equal(classified[0].context, 'Here is a drink for the outdoors. / Now back to our hike.');
  assert.equal(state.source, 'captions');
  await app.send({ type: 'analyzeAhead', videoId: VIDEO, position: 1000 });
  await app.send({ type: 'analyzeAhead', videoId: VIDEO, position: 1000 });
  assert.equal(calls.filter(c => c.url.endsWith('/prepare-video')).length, 1);
  assert.equal(calls.filter(c => c.url.endsWith('/classify')).length, 1);
});

test('missing model answers fail without marking captions checked', async () => {
  const app = harness(captionServer([], {}));
  const response = await app.send({ type: 'analyzeAhead', videoId: VIDEO, position: 1000 });
  assert.match(response.error, /invalid classifier score/);
  const state = await app.send({ type: 'getState', videoId: VIDEO });
  assert.deepEqual(JSON.parse(JSON.stringify(state.processedChunks)), []);
});

test('concurrent tabs serialize analysis without losing completed ranges', async () => {
  const app = harness(captionServer([]));
  await Promise.all([0, 1000].map(position => app.send({ type: 'analyzeAhead', videoId: VIDEO, position })));
  const state = await app.send({ type: 'getState', videoId: VIDEO });
  assert.deepEqual(JSON.parse(JSON.stringify(state.processedChunks)), [[0, 60], [1000, 1060]]);
});

test('without captions, fetches a future audio slice rather than recording playback', async () => {
  const calls = [];
  const app = harness(async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, body });
    if (url.endsWith('/prepare-video')) return ok({ source: 'audio', duration: 1800, language: 'en', segments: [] });
    if (url.endsWith('/transcribe-video')) return ok({ segments: [], chunkRange: [1000, 1030] });
    assert.fail(url);
  });
  const state = await app.send({ type: 'analyzeAhead', videoId: VIDEO, position: 1000 });
  assert.equal(state.source, 'audio');
  assert.deepEqual(calls[1].body, { videoId: VIDEO, start: 1000, end: 1030 });
  assert.deepEqual(JSON.parse(JSON.stringify(state.processedChunks)), [[1000, 1030]]);
});

test('extractor failures propagate and can be retried', async () => {
  let fail = true;
  const good = captionServer([]);
  const app = harness((...args) => fail ? Promise.reject(new Error('YouTube unavailable')) : good(...args));
  assert.match((await app.send({ type: 'analyzeAhead', videoId: VIDEO, position: 0 })).error, /YouTube unavailable/);
  fail = false;
  assert.equal((await app.send({ type: 'analyzeAhead', videoId: VIDEO, position: 0 })).error, undefined);
});

test('timeline does not treat gaps or seeks as checked', () => {
  assert.equal(timeline.checkedEnd([[100, 160], [160, 220]], 110), 220);
  assert.equal(timeline.checkedEnd([[100, 160], [200, 260]], 170), 170);
  assert.deepEqual(timeline.nextRange([[100, 160]], 500, 1000, 60), [500, 560]);
  assert.equal(timeline.nextRange([[0, 1000]], 999, 1000, 60), null);
  assert.equal(timeline.skipTarget([{ start: 10, end: 20 }, { start: 18, end: 30 }], 12), 30);
});
