const http = require('http');
const { randomUUID } = require('node:crypto');
const { transcribeChunk } = require('./transcribe');
const { prepareVideo, transcribeVideo, validateVideoId } = require('./video-source');

const PORT = process.env.PORT || 8787;
const TYPESAFE_API_KEY = process.env.TYPESAFE_API_KEY;
const TYPESAFE_URL = 'https://api.typesafe.ai/v1/systemone';

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload);
}

function buildRequestBody(segments) {
  const state = {};
  const questions = {};
  for (const { id, text, context } of segments) {
    state[id] = { text, context: context || '' };
    questions[id] = {
      type: 'noul',
      instructions:
        `Is this transcript segment a creator-inserted sponsor/advertisement read (not YouTube's own ad), based on \`state.${id}.text\` and \`state.${id}.context\`? yes or no.`,
      criteria: {
        true: 'segment promotes/reads an ad for a product, service, or sponsor, e.g. discount codes, "this video is sponsored by", brand pitch',
        false: 'segment is normal video content unrelated to sponsorship',
      },
    };
  }
  return { state, model: 'jev-latest', questions };
}

async function callTypeSafe(segments, logPrefix) {
  const body = buildRequestBody(segments);
  console.log(`${logPrefix} -> Jev: ${segments.length} segment(s)`);
  for (const seg of segments) {
    console.log(`${logPrefix} segment ${seg.id}: ${JSON.stringify(seg.text)}; context: ${JSON.stringify(seg.context || '')}`);
  }
  const maxRetries = 4;
  let attempt = 0;
  while (true) {
    const startedAt = Date.now();
    console.log(`${logPrefix} Jev attempt ${attempt + 1}/${maxRetries + 1}`);
    const res = await fetch(TYPESAFE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TYPESAFE_API_KEY}`,
      },
      body: JSON.stringify(body),
    });
    console.log(`${logPrefix} Jev HTTP ${res.status} after ${Date.now() - startedAt}ms`);
    if (res.status === 429 || res.status === 529) {
      if (attempt >= maxRetries) throw new Error(`TypeSafe overloaded after retries: ${res.status}`);
      const delay = Math.min(1000 * 2 ** attempt, 8000);
      console.warn(`${logPrefix} Jev overloaded; retrying in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
      attempt += 1;
      continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error(`${logPrefix} <- Jev error ${res.status}:`, text);
      throw new Error(`TypeSafe error ${res.status}: ${text}`);
    }
    const json = await res.json();
    console.log(`${logPrefix} <- Jev answers: ${JSON.stringify(json.answers)}`);
    return json;
  }
}

function mapResults(answers) {
  const results = {};
  for (const [id, answer] of Object.entries(answers || {})) {
    results[id] = { noul: answer.noul };
  }
  return results;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
  });
}

const videoTasks = new Map();
async function handleVideo(req, res) {
  try {
    const { videoId, start, end, jobId } = await readBody(req);
    if (req.url === '/video-job') {
      const job = videoTasks.get(jobId);
      if (!job) { sendJson(res, 404, { error: 'Analysis job expired. Retry preparation.' }); return; }
      sendJson(res, job.error ? 502 : 200, job);
      return;
    }
    validateVideoId(videoId);
    for (const [id, job] of videoTasks) if (job.createdAt < Date.now() - 10 * 60 * 1000) videoTasks.delete(id);
    if (videoTasks.size >= 100) throw new Error('Too many pending video jobs. Try again shortly.');
    const id = randomUUID();
    const job = { pending: true, createdAt: Date.now() };
    videoTasks.set(id, job);
    const operation = req.url === '/prepare-video' ? prepareVideo(videoId) : transcribeVideo(videoId, start, end);
    operation.then(result => { job.result = result; job.pending = false; }).catch(err => {
      console.error(`${req.logPrefix} job failed:`, err.message);
      job.error = err.message;
      job.pending = false;
    });
    sendJson(res, 202, { jobId: id });
  } catch (err) {
    console.error(`${req.logPrefix} failed:`, err.message);
    sendJson(res, 502, { error: err.message });
  }
}

async function handleClassify(req, res) {
  if (!TYPESAFE_API_KEY) {
    console.error(`${req.logPrefix} classification unavailable: TYPESAFE_API_KEY is not set`);
    sendJson(res, 500, { error: 'TYPESAFE_API_KEY is not set on the server' });
    return;
  }

  let parsed;
  try {
    parsed = await readBody(req);
  } catch (err) {
    sendJson(res, 400, { error: err.message });
    return;
  }

  const segments = parsed.segments;
  if (!Array.isArray(segments) || segments.length === 0) {
    sendJson(res, 400, { error: 'segments must be a non-empty array' });
    return;
  }

  try {
    const typesafeResp = await callTypeSafe(segments, req.logPrefix);
    sendJson(res, 200, { results: mapResults(typesafeResp.answers) });
  } catch (err) {
    console.error(`${req.logPrefix} classification failed:`, err.message);
    sendJson(res, 502, { error: err.message });
  }
}

async function handleTranscribe(req, res) {
  let parsed;
  try {
    parsed = await readBody(req);
  } catch (err) {
    sendJson(res, 400, { error: err.message });
    return;
  }

  const { pcm, sampleRate, chunkStart } = parsed;
  if (typeof pcm !== 'string' || typeof sampleRate !== 'number' || typeof chunkStart !== 'number') {
    sendJson(res, 400, { error: 'expected { pcm: base64 string, sampleRate: number, chunkStart: number }' });
    return;
  }

  try {
    const bytes = Buffer.byteLength(pcm, 'base64');
    const duration = bytes / Float32Array.BYTES_PER_ELEMENT / sampleRate;
    console.log(`${req.logPrefix} audio received: chunk start=${chunkStart.toFixed(2)}s, duration=${duration.toFixed(2)}s, sampleRate=${sampleRate}Hz, bytes=${bytes}`);
    const startedAt = Date.now();
    const segments = await transcribeChunk(pcm, sampleRate, chunkStart);
    console.log(`${req.logPrefix} transcription finished in ${Date.now() - startedAt}ms: ${segments.length} segment(s)`);
    if (segments.length === 0) console.log(`${req.logPrefix} no transcript segments returned`);
    for (const seg of segments) {
      console.log(`${req.logPrefix} transcript ${seg.id} [${seg.start.toFixed(2)}s-${seg.end.toFixed(2)}s]: ${JSON.stringify(seg.text)}`);
    }
    sendJson(res, 200, { segments });
  } catch (err) {
    console.error(`${req.logPrefix} transcription failed:`, err.message, err);
    sendJson(res, 502, { error: err.message });
  }
}

let requestId = 0;
const server = http.createServer((req, res) => {
  const startedAt = Date.now();
  req.logPrefix = `[server #${++requestId} ${req.method} ${req.url}]`;
  console.log(`${req.logPrefix} received at ${new Date(startedAt).toISOString()}`);
  res.on('finish', () => console.log(`${req.logPrefix} -> ${res.statusCode} in ${Date.now() - startedAt}ms`));
  res.on('close', () => {
    if (!res.writableFinished) console.warn(`${req.logPrefix} client disconnected after ${Date.now() - startedAt}ms`);
  });
  if (req.method !== 'POST') {
    sendJson(res, 404, { error: 'not found' });
    return;
  }
  if (['/prepare-video', '/transcribe-video', '/video-job'].includes(req.url)) {
    handleVideo(req, res);
  } else if (req.url === '/classify') {
    handleClassify(req, res);
  } else if (req.url === '/transcribe') {
    handleTranscribe(req, res);
  } else {
    sendJson(res, 404, { error: 'not found' });
  }
});

server.listen(PORT, () => {
  console.log(`[server] listening on port ${server.address().port}; PID=${process.pid}; started=${new Date().toISOString()}`);
  if (!TYPESAFE_API_KEY) {
    console.warn('TYPESAFE_API_KEY is not set; /classify will return 500 until it is');
  }
});

module.exports = server;
