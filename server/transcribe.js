// Whisper tiny.en via Transformers.js, running in Node instead of the browser.
// Moved server-side because the browser-side version (a Worker, either inside
// the content script or an offscreen document) depended on youtube.com's CSP
// and the extension's network stack; Node has neither constraint. Audio never
// leaves the machine either way - this server only ever binds to localhost.

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

async function transcribeChunk(pcmBase64, sampleRate, chunkStart) {
  const buf = Buffer.from(pcmBase64, 'base64');
  const pcm = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / Float32Array.BYTES_PER_ELEMENT);

  const transcriber = await getTranscriber();
  const result = await transcriber(pcm, {
    sampling_rate: sampleRate,
    return_timestamps: 'word',
    chunk_length_s: 30,
  });

  return groupIntoSegments(result, chunkStart);
}

module.exports = { transcribeChunk };
