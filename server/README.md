# Local analysis server

Requires Node.js 22+, Python 3.10+ (3.11+ recommended), and FFmpeg for the audio fallback.

## First-time setup

Run from this directory:

```sh
npm install
python3 -m venv .venv
.venv/bin/pip install 'yt-dlp[default]'
```

Install FFmpeg with your package manager if missing (macOS: `brew install ffmpeg`). The server automatically uses `.venv/bin/yt-dlp`; `YT_DLP_PATH` and `FFMPEG_PATH` can override executable locations.

## Start

```sh
export TYPESAFE_API_KEY='your-key'
npm start
```

Restart with Ctrl+C and `npm start` after code changes. The extension calls port 8787, so leave PORT unset unless you also change the extension URLs.

## How it works

`POST /prepare-video` takes `{videoId}` and starts a job to fetch the full timed captions with yt-dlp. It prefers English creator captions, then original English automatic captions. Available original-language captions are preferred over translated tracks. Captions bypass Whisper completely.

If usable captions are unavailable, the source is `audio`. `POST /transcribe-video` takes `{videoId,start,end}` and fetches that audio range independently of browser playback with FFmpeg, converts it to 16 kHz mono, and transcribes with Whisper tiny.en (English only). The first fallback request downloads the model.

Both endpoints return `{jobId}` with status 202. Poll `POST /video-job` with `{jobId}` until `pending` is false; the response contains `result` or `error`. This keeps extension fetches short during downloads.

`POST /classify` takes `{segments:[{id,text,context}]}` and returns `{results:{[id]:{noul}}}`. It requires TYPESAFE_API_KEY. Transcript text is sent to TypeSafe; Whisper audio stays local after download.

The older `POST /transcribe` PCM endpoint remains available for diagnostics but the extension no longer captures live audio.

## Logs and troubleshooting

The terminal prints source selection, caption counts, request IDs, timing, transcript details for audio fallback, and Jev inputs/results. The extension service worker console shows checked ranges and skip decisions.

If YouTube extraction fails, update `.venv/bin/pip install --upgrade 'yt-dlp[default]'` and restart. Private/restricted videos, live streams, unavailable captions, and YouTube rate limits can prevent analysis. No browser cookies are read automatically.

The player shows errors with Retry and Continue without skipping buttons. It never marks a failed request as checked.
