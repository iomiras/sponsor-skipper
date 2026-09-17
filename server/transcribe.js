// Whisper tiny.en via Transformers.js, running in Node instead of the browser.
// Moved server-side because the browser-side version (a Worker, either inside
// the content script or an offscreen document) depended on youtube.com's CSP
// and the extension's network stack; Node has neither constraint. Audio never
// leaves the machine either way - this server only ever binds to localhost.

const { decodeAudio, WHISPER_SAMPLE_RATE } = require('./audio');

let transcriberPromise = null;

function logProgress(data) {
  if (data.status === 'progress') {
    console.log(`[transcribe] downloading ${data.file}: ${Math.round(data.progress)}%`);
  } else if (data.status === 'done') {
    console.log(`[transcribe] fetched ${data.file}`);
  }
}

async function getTranscriber() {
  if (!transcriberPromise) {
    console.log('[transcribe] loading Whisper tiny.en...');
    const { pipeline, env } = await import('@xenova/transformers');
    env.allowLocalModels = false;
    transcriberPromise = pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en', {
      progress_callback: logProgress,
    }).then((t) => {
      console.log('[transcribe] Whisper loaded');
      return t;
    });
  }
  return transcriberPromise;
}

// Groups word-level timestamps into sentence-ish segments and offsets them to absolute video time.
function groupIntoSegments(result, chunkStartAbs, duration) {
  const chunks = result.chunks || [{ text: result.text, timestamp: [0, duration] }];
  const segments = [];
  let buffer = [];
  let segStart = null;

  const flush = () => {
    if (buffer.length === 0) return;
    const text = buffer.map((c) => c.text.trim()).join(' ');
    const lastEnd = Math.max(...buffer.map((c) => c.timestamp[1]));
    if (text && lastEnd > segStart) {
      segments.push({ start: chunkStartAbs + segStart, end: chunkStartAbs + lastEnd, text });
    }
    buffer = [];
    segStart = null;
  };

  let previousStart = 0;
  for (const c of chunks) {
    const start = c.timestamp?.[0];
    const end = c.timestamp?.[1] ?? start;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < previousStart || end < start || start >= duration) {
      console.warn(`[transcribe chunk=${chunkStartAbs.toFixed(2)}s] dropping invalid word timestamp: ${JSON.stringify(c.timestamp)}`);
      continue;
    }
    previousStart = start;
    if (segStart === null) segStart = start;
    buffer.push({ text: c.text, timestamp: [start, Math.min(end, duration)] });
    if (/[.!?]\s*$/.test(c.text) || buffer.length >= 15) flush();
  }
  flush();

  return segments.map((s, i) => ({ ...s, id: `${chunkStartAbs}-${i}` }));
}

async function transcribeChunk(pcmBase64, sampleRate, chunkStart) {
  const { samples: pcm, duration } = decodeAudio(pcmBase64, sampleRate);

  const logPrefix = `[transcribe chunk=${chunkStart.toFixed(2)}s]`;
  console.log(`${logPrefix} prepared ${duration.toFixed(2)}s audio: ${sampleRate}Hz -> ${WHISPER_SAMPLE_RATE}Hz (${pcm.length} samples)`);
  console.log(`${logPrefix} waiting for Whisper model`);
  const transcriber = await getTranscriber();
  console.log(`${logPrefix} running Whisper on ${pcm.length} samples at ${WHISPER_SAMPLE_RATE}Hz`);
  const startedAt = Date.now();
  const result = await transcriber(pcm, {
    return_timestamps: 'word',
    chunk_length_s: 30,
  });
  console.log(`${logPrefix} Whisper finished in ${Date.now() - startedAt}ms; text: ${JSON.stringify(result.text || '')}`);

  return groupIntoSegments(result, chunkStart, duration);
}

module.exports = { transcribeChunk };
