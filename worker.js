// Runs in the content script's Worker context (window-owned), not the service worker.
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2';

// Model weights cache via the library's default (browser HTTP cache + IndexedDB); no extra wiring needed.
env.allowLocalModels = false;

// logs one line per model file so a slow/stalled ~75MB download is visible, not indistinguishable from a hang.
function logProgress(data) {
  if (data.status === 'progress') {
    console.log(`[ytsb] downloading ${data.file}: ${Math.round(data.progress)}%`);
  } else if (data.status === 'done') {
    console.log(`[ytsb] fetched ${data.file}`);
  }
}

let transcriberPromise = null;
function getTranscriber() {
  if (!transcriberPromise) {
    console.log('[ytsb] loading Whisper tiny.en (webgpu, falls back to wasm)...');
    transcriberPromise = pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en', {
      device: 'webgpu',
      progress_callback: logProgress,
    })
      .then((t) => {
        console.log('[ytsb] Whisper loaded on webgpu');
        return t;
      })
      .catch((err) => {
        console.warn('[ytsb] webgpu load failed, falling back to wasm:', err.message);
        return pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en', {
          device: 'wasm',
          progress_callback: logProgress,
        }).then((t) => {
          console.log('[ytsb] Whisper loaded on wasm');
          return t;
        });
      });
  }
  return transcriberPromise;
}

self.onmessage = async (e) => {
  const { type, videoId, chunkRange, pcm, sampleRate } = e.data;
  if (type !== 'transcribeChunk') return;

  try {
    console.log(`[ytsb] transcribing chunk [${chunkRange[0]}s-${chunkRange[1]}s]...`);
    const transcriber = await getTranscriber();
    const [chunkStart] = chunkRange;

    const result = await transcriber(pcm, {
      sampling_rate: sampleRate,
      return_timestamps: 'word',
      chunk_length_s: 30,
    });

    const segments = groupIntoSegments(result, chunkStart);
    console.log(`[ytsb] chunk [${chunkRange[0]}s-${chunkRange[1]}s] done: "${result.text}"`);
    self.postMessage({ type: 'chunkResult', videoId, chunkRange, segments });
  } catch (err) {
    // still posts a (empty) result so background.js/content.js don't wedge waiting on this chunk forever.
    console.error(`[ytsb] chunk [${chunkRange[0]}s-${chunkRange[1]}s] failed:`, err.message, err);
    self.postMessage({ type: 'chunkResult', videoId, chunkRange, segments: [] });
  }
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
