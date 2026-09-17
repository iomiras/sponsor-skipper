# YouTube Sponsor Segment Skipper

A Chrome MV3 extension that auto-skips creator-inserted sponsor reads in YouTube videos. It transcribes audio locally with Whisper (via Transformers.js, running in a small local server) and classifies each transcript segment with TypeSafe's Jev models. It does not touch YouTube's own inserted ads; those are a DOM signal, out of scope here.

## Install

1. Start the local server: see `server/README.md` (`cd server && npm install && export TYPESAFE_API_KEY=... && npm start`). This also downloads the Whisper model (~75MB) on its first request.
2. Open `chrome://extensions`, enable Developer Mode, click "Load unpacked", and select this project's root directory.
3. Open a YouTube video. The extension transcribes upcoming audio in the background and skips ranges it classifies as sponsor reads.
4. Click the extension icon to toggle it on/off, see how far the current video has been checked, and manually skip a detected range.

## Known limitations

- The lookahead window is a live guarantee only for unreached content.
- A fast seek ahead of the window may briefly show unchecked content.
- Sponsor segments with no distinct trigger phrase may be missed by the keyword prefilter.
- Non-English or music-only sponsor reads are missed by the English-only STT.

## Architecture notes

- `background.js` is the only file that talks to the local server (both `/transcribe` and `/classify`), and it is the only file that touches `chrome.storage.local`; `content.js` and `popup.js` read and write state through its message handlers.
- Whisper runs inside `server/transcribe.js`, a Node process, not inside the browser. It started as a browser-side Web Worker, but youtube.com's CSP has no `worker-src` directive and falls back to `script-src`, which blocked every in-page attempt (a Worker built from `chrome-extension://`, from a `blob:` URL, and even from an offscreen document all hit some form of this). Moving it to a local Node server sidesteps every browser-specific restriction. It is still fully local: the server only ever binds to `localhost`, so audio never leaves the machine, it just moves from the browser tab to a local Node process.
- Audio is captured by tapping the video element's live playback (`MediaElementAudioSourceNode` plus a `ScriptProcessorNode`), so transcription trails playback by roughly one chunk rather than running arbitrarily far ahead; the `LOOKAHEAD_SECONDS` window governs when capture is active and when the popup reports content as checked, not a true prefetch of unplayed audio.
