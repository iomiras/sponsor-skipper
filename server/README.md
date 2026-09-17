# classify proxy

Holds `TYPESAFE_API_KEY` server-side and batches sponsor-segment classification for the extension. The extension never sees this key.

## Setup

```
cd server
npm install
export TYPESAFE_API_KEY=sk-...
npm start
```

Listens on port 8787.

## API

`POST /classify`

Request:

```json
{ "segments": [{ "id": "120-0", "text": "...", "context": "..." }] }
```

Response:

```json
{ "results": { "120-0": { "noul": 0.82 } } }
```

If `TYPESAFE_API_KEY` is unset, every request returns `500 { "error": "TYPESAFE_API_KEY is not set on the server" }` instead of crashing.
