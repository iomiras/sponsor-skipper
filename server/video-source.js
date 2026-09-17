const { execFile } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const { parseCaptions, selectCaptionTrack } = require('./captions');
const { transcribeChunk } = require('./transcribe');

const runFile = promisify(execFile);
const localYtDlp = path.join(__dirname, '.venv', 'bin', 'yt-dlp');
const videos = new Map();

function validateVideoId(videoId) {
  if (typeof videoId !== 'string' || !/^[\w-]{11}$/.test(videoId)) throw new Error('Invalid YouTube video ID');
}

async function extractVideo(videoId) {
  const executable = process.env.YT_DLP_PATH || (existsSync(localYtDlp) ? localYtDlp : 'yt-dlp');
  console.log(`[video ${videoId}] fetching metadata and subtitle tracks`);
  let stdout;
  try {
    ({ stdout } = await runFile(executable, [
      '--ignore-config', '--no-playlist', '--no-warnings', '--skip-download', '--dump-single-json',
      '--no-check-formats', '--format', 'bestaudio/best', '--js-runtimes', `node:${process.execPath}`,
      '--', `https://www.youtube.com/watch?v=${videoId}`,
    ], { timeout: 90000, maxBuffer: 24 * 1024 * 1024 }));
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error('yt-dlp is missing. Run the setup commands in server/README.md, then restart the server.');
    console.error(`[video ${videoId}] extraction failed:`, err.stderr || err.message);
    throw new Error('YouTube extraction failed. Check the server logs and update yt-dlp; restricted videos may be unavailable.');
  }
  const info = JSON.parse(stdout);
  if (info.is_live || info.live_status === 'is_upcoming' || !Number.isFinite(info.duration) || info.duration <= 0) {
    throw new Error('Advance analysis requires a recorded video with a known duration.');
  }
  const track = selectCaptionTrack(info);
  let segments = [];
  if (track) {
    console.log(`[video ${videoId}] downloading ${track.kind} captions (${track.language})`);
    try {
      const response = await fetch(track.url, { signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error(`caption HTTP ${response.status}`);
      segments = parseCaptions(await response.json(), info.duration);
    } catch (err) {
      console.warn(`[video ${videoId}] captions unavailable: ${err.message}; using audio fallback`);
    }
  }
  const source = segments.length ? 'captions' : 'audio';
  console.log(`[video ${videoId}] source=${source}, duration=${info.duration}s, caption segments=${segments.length}`);
  return { info, source, duration: info.duration, language: source === 'captions' ? track.language : 'en', segments };
}

async function getVideo(videoId) {
  validateVideoId(videoId);
  const cached = videos.get(videoId);
  if (cached && cached.expires > Date.now()) return cached.promise;
  if (videos.size >= 10) videos.delete(videos.keys().next().value);
  const promise = extractVideo(videoId).catch((err) => { videos.delete(videoId); throw err; });
  videos.set(videoId, { promise, expires: Date.now() + 30 * 60 * 1000 });
  return promise;
}

async function prepareVideo(videoId) {
  const { source, duration, language, segments } = await getVideo(videoId);
  return { videoId, source, duration, language, segments };
}

async function transcribeVideo(videoId, start, end) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end - start > 60) {
    throw new Error('Audio range must be between 0 and 60 seconds long');
  }
  const { info, duration } = await getVideo(videoId);
  end = Math.min(end, duration);
  if (end <= start || !info.url) throw new Error('Requested audio is unavailable');
  const headers = Object.entries(info.http_headers || {})
    .filter(([name, value]) => !/[\r\n]/.test(name + value))
    .map(([name, value]) => `${name}: ${value}\r\n`).join('');
  console.log(`[video ${videoId}] fetching audio [${start}s-${end}s] independently of playback`);
  let stdout;
  try {
    ({ stdout } = await runFile(process.env.FFMPEG_PATH || 'ffmpeg', [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-rw_timeout', '20000000',
      ...(headers ? ['-headers', headers] : []), '-ss', String(start), '-i', info.url,
      '-t', String(end - start), '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', 'pipe:1',
    ], { encoding: 'buffer', timeout: 90000, maxBuffer: 5 * 1024 * 1024 }));
  } catch (err) {
    videos.delete(videoId); // Refresh expired media URLs on a manual retry.
    if (err.code === 'ENOENT') throw new Error('FFmpeg is required for videos without captions. Install it and restart the server.');
    console.error(`[video ${videoId}] audio download failed:`, err.stderr?.toString() || err.message);
    throw new Error('Could not fetch audio ahead. Check server logs, then retry.');
  }
  const actualDuration = stdout.length / 4 / 16000;
  if (actualDuration < end - start - 0.5) throw new Error('Audio download was incomplete; range was not marked checked.');
  const segments = await transcribeChunk(stdout.toString('base64'), 16000, start);
  for (const segment of segments) console.log(`[video ${videoId}] [${segment.start.toFixed(2)}-${segment.end.toFixed(2)}] ${segment.text}`);
  return { segments, chunkRange: [start, end] };
}

module.exports = { prepareVideo, transcribeVideo, validateVideoId };
