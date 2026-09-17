const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { test } = require('node:test');
const { decodeAudio } = require('../server/audio');

function encode(samples) {
  return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).toString('base64');
}

function tone(sampleRate, frequency, seconds = 1) {
  return Float32Array.from({ length: sampleRate * seconds }, (_, i) => Math.sin(2 * Math.PI * frequency * i / sampleRate));
}

for (const rate of [44100, 48000]) {
  test(`${rate}Hz audio becomes 16kHz without changing duration or pitch`, () => {
    const { samples, duration } = decodeAudio(encode(tone(rate, 440)), rate);
    assert.equal(duration, 1);
    assert.equal(samples.length, 16000);
    assert.ok(samples instanceof Float32Array);
    let crossings = 0;
    for (let i = 1; i < samples.length; i++) {
      if (samples[i - 1] <= 0 && samples[i] > 0) crossings++;
    }
    assert.ok(Math.abs(crossings - 440) <= 1, `expected 440Hz, got ${crossings} crossings`);
  });
}

test('downsampling suppresses frequencies above the new Nyquist limit', () => {
  const { samples } = decodeAudio(encode(tone(48000, 12000)), 48000);
  const middle = samples.subarray(100, -100);
  const rms = Math.sqrt(middle.reduce((sum, x) => sum + x * x, 0) / middle.length);
  assert.ok(rms < 0.1, `12kHz tone should be filtered, RMS=${rms}`);
});

test('16kHz samples are preserved exactly', () => {
  const original = tone(16000, 440);
  assert.deepEqual(decodeAudio(encode(original), 16000).samples, original);
});

test('invalid PCM and sample rates are rejected before inference', () => {
  for (const rate of [0, -1, NaN, 44100.5]) {
    assert.throws(() => decodeAudio('AAAAAA==', rate), /sampleRate/);
  }
  for (const payload of ['', 'AA==', encode(new Float32Array([NaN]))]) {
    assert.throws(() => decodeAudio(payload, 44100), /PCM/);
  }
});

test('reported 1,323,008-sample chunk reaches Whisper as 30 seconds with bounded timestamps', async () => {
  const filename = path.resolve(__dirname, '../server/transcribe.js');
  let modelInput;
  const context = vm.createContext({
    require: createRequire(filename), module: { exports: {} },
    console: { log() {}, warn() {} },
    mockTranscriber: async (samples, options) => {
      modelInput = { samples, options };
      return {
        text: 'Hello world. End.',
        chunks: [
          { text: ' Hello', timestamp: [0, 0.5] },
          { text: ' world.', timestamp: [0.5, 1] },
          { text: ' invalid', timestamp: [3, 2] },
          { text: ' End.', timestamp: [29, 83] },
          { text: ' backward.', timestamp: [1, 2] },
          { text: ' outside.', timestamp: [80, 83] },
        ],
      };
    },
  });
  vm.runInContext(fs.readFileSync(filename, 'utf8'), context);
  vm.runInContext('transcriberPromise = Promise.resolve(mockTranscriber)', context);
  const original = new Float32Array(1323008).fill(0.25);
  const segments = await context.module.exports.transcribeChunk(encode(original), 44100, 1539.400897);
  assert.ok(Math.abs(modelInput.samples.length - 1323008 / 44100 * 16000) <= 1);
  assert.equal(modelInput.options.sampling_rate, undefined);
  assert.equal(segments.length, 2);
  assert.equal(segments[0].text, 'Hello world.');
  for (const segment of segments) {
    assert.ok(segment.start >= 1539.400897);
    assert.ok(segment.end > segment.start);
    assert.ok(segment.end <= 1539.400897 + original.length / 44100);
  }
});
