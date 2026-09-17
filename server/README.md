# local server

Runs Whisper tiny.en transcription and holds `TYPESAFE_API_KEY` server-side for sponsor-segment classification. Only binds to `localhost`; the extension never sees the API key, and audio never leaves the machine.

## Setup

```
cd server
npm install
export TYPESAFE_API_KEY=sk-...
npm start
```

Listens on port 8787. The first `/transcribe` request downloads the Whisper model (~75MB) and caches it on disk; later requests reuse it.

## API

`POST /transcribe`

Request:

```json
{ "pcm": "<base64 float32 PCM bytes>", "sampleRate": 48000, "chunkStart": 0 }
```

Response:

```json
{ "segments": [{ "start": 2.1, "end": 5.4, "text": "...", "id": "0-0" }] }
```

`POST /classify`

Request:

```json
{ "segments": [{ "id": "120-0", "text": "...", "context": "..." }] }
```

Response:

```json
{ "results": { "120-0": { "noul": 0.82 } } }
```

If `TYPESAFE_API_KEY` is unset, `/classify` returns `500 { "error": "TYPESAFE_API_KEY is not set on the server" }` instead of crashing. `/transcribe` works without it.
