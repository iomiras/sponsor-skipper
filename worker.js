// Runs in the content script's Worker context (window-owned), not the service worker.
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2';

// Model weights cache via the library's default (browser HTTP cache + IndexedDB); no extra wiring needed.
env.allowLocalModels = false;

let transcriberPromise = null;
function getTranscriber() {
  if (!transcriberPromise) {
    transcriberPromise = pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en', {
      device: 'webgpu',
    }).catch(() =>
      pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en', { device: 'wasm' })
    );
  }
  return transcriberPromise;
}

self.onmessage = async (e) => {
  const { type, videoId, chunkRange, pcm, sampleRate } = e.data;
  if (type !== 'transcribeChunk') return;

  const transcriber = await getTranscriber();
  const [chunkStart] = chunkRange;

  const result = await transcriber(pcm, {
    sampling_rate: sampleRate,
    return_timestamps: 'word',
    chunk_length_s: 30,
  });

  const segments = groupIntoSegments(result, chunkStart);
  self.postMessage({ type: 'chunkResult', videoId, chunkRange, segments });
};

// Groups word-level timestamps into sentence-ish segments and offsets them to absolute video time.
function groupIntoSegments(result, chunkStartAbs) {
  const chunks = result.chunks || [{ text: result.text, timestamp: [0, null] }];
  const segments = [];
  let buffer = [];
  let segStart = null;

  const flush = () => {
    if (buffer.length === 0) return;
    const text = buffer.map((c) => c.text).join(' ').trim();
    const lastEnd = buffer[buffer.length - 1].timestamp[1] ?? buffer[buffer.length - 1].timestamp[0];
    segments.push({
      start: chunkStartAbs + segStart,
      end: chunkStartAbs + lastEnd,
      text,
    });
    buffer = [];
    segStart = null;
  };

  for (const c of chunks) {
    if (segStart === null) segStart = c.timestamp[0];
    buffer.push(c);
    if (/[.!?]\s*$/.test(c.text) || buffer.length >= 15) flush();
  }
  flush();

  return segments.map((s, i) => ({ ...s, id: `${chunkStartAbs}-${i}` }));
}
