# YouTube Sponsor Segment Skipper

A Chrome MV3 extension that analyzes timed captions ahead of playback and skips creator-inserted sponsor reads using TypeSafe's Jev classifier.

## Start

1. Follow `server/README.md` for dependencies. Start the backend with `cd server`, `export TYPESAFE_API_KEY='your-key'`, then `npm start`.
2. Open `chrome://extensions`, enable Developer Mode, and load this project's root directory as an unpacked extension. If already loaded, click Reload.
3. Refresh the YouTube tab and watch normally. Analysis runs in the background; detected sponsor segments are skipped automatically.

After any code change, restart the server, reload the extension, and refresh YouTube.

## Analysis ahead of playback

- Fetches the full timed subtitles, including automatic captions, without running Whisper when captions are usable.
- Classifies 60-second sections near the current playback position and maintains about two minutes of checked coverage ahead.
- For videos without usable captions, downloads 30-second audio slices independently of the player, then transcribes locally with Whisper.
- Playback continues while analysis runs, including after seeking into unchecked content. A newly detected sponsor is skipped immediately if playback is already inside it. There is no preparation overlay or automatic pause/resume.
- Caches completed classifications in extension storage. Concurrent tabs of the same video serialize updates. Old live-capture cache entries are ignored.
- The popup shows the source, seconds checked ahead, and detected ranges. Failed analysis retries after 30 seconds without interrupting playback.

## Limitations

If analysis is late, you may hear part or all of a sponsor before it is detected. Already-passed ranges do not rewind playback. Classifier mistakes and imperfect caption timestamps can cause missed or incorrect skips. Live streams and restricted videos may be unavailable. The audio fallback uses English-only Whisper tiny.en. YouTube's own ads are not the target; the player controller leaves recognized ad playback alone.

Non-empty transcript segments and their context are sent to TypeSafe, so usage grows with viewing time. Audio fallback downloads and transcription run locally. The API key stays on the server.

## Development

Run `node --test tests/*.test.cjs` from the project root. The server prints request logs, caption selection, and classifier results. Inspect the extension's service worker at `chrome://extensions` for scheduling and cache details. The content script does not use ScriptProcessorNode or capture playback audio.
