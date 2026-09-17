const http = require('http');
const { transcribeChunk } = require('./transcribe');

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

async function callTypeSafe(segments) {
  const body = buildRequestBody(segments);
  console.log(`[proxy] -> Jev: ${segments.length} noul question(s)`, Object.keys(body.questions));
  const maxRetries = 4;
  let attempt = 0;
  while (true) {
    const res = await fetch(TYPESAFE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TYPESAFE_API_KEY}`,
      },
      body: JSON.stringify(body),
    });
    if (res.status === 429 || res.status === 529) {
      if (attempt >= maxRetries) throw new Error(`TypeSafe overloaded after retries: ${res.status}`);
      await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** attempt, 8000)));
      attempt += 1;
      continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error(`[proxy] <- Jev error ${res.status}:`, text);
      throw new Error(`TypeSafe error ${res.status}: ${text}`);
    }
    const json = await res.json();
    console.log('[proxy] <- Jev answers:', json.answers);
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

async function handleClassify(req, res) {
  if (!TYPESAFE_API_KEY) {
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
    const typesafeResp = await callTypeSafe(segments);
    sendJson(res, 200, { results: mapResults(typesafeResp.answers) });
  } catch (err) {
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
    const segments = await transcribeChunk(pcm, sampleRate, chunkStart);
    sendJson(res, 200, { segments });
  } catch (err) {
    console.error('[transcribe] failed:', err.message, err);
    sendJson(res, 502, { error: err.message });
  }
}

const server = http.createServer((req, res) => {
  if (req.method !== 'POST') {
    sendJson(res, 404, { error: 'not found' });
    return;
  }
  if (req.url === '/classify') {
    handleClassify(req, res);
  } else if (req.url === '/transcribe') {
    handleTranscribe(req, res);
  } else {
    sendJson(res, 404, { error: 'not found' });
  }
});

server.listen(PORT, () => {
  console.log(`classify proxy listening on port ${PORT}`);
  if (!TYPESAFE_API_KEY) {
    console.warn('TYPESAFE_API_KEY is not set; /classify will return 500 until it is');
  }
});

module.exports = server;
