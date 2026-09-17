# YouTube Sponsor Segment Skipper

A Chrome MV3 extension that auto-skips creator-inserted sponsor reads in YouTube videos. It transcribes audio on-device with Whisper (via Transformers.js) and classifies each transcript segment with TypeSafe's Jev models. It does not touch YouTube's own inserted ads; those are a DOM signal, out of scope here.

## Install

1. Start the classify proxy: see `server/README.md` (`cd server && npm install && export TYPESAFE_API_KEY=... && npm start`).
2. Open `chrome://extensions`, enable Developer Mode, click "Load unpacked", and select this project's root directory.
3. Open a YouTube video. The extension transcribes upcoming audio in the background and skips ranges it classifies as sponsor reads.
4. Click the extension icon to toggle it on/off, see how far the current video has been checked, and manually skip a detected range.

## Known limitations

- The lookahead window is a live guarantee only for unreached content.
- A fast seek ahead of the window may briefly show unchecked content.
- Sponsor segments with no distinct trigger phrase may be missed by the keyword prefilter.
- Non-English or music-only sponsor reads are missed by the English-only STT.

## Architecture notes

- `background.js` is the only file allowed to fetch the local proxy, and it is the only file that touches `chrome.storage.local`; `content.js` and `popup.js` read and write state through its message handlers.
- The Web Worker in `worker.js` is spawned from `content.js`, not `background.js`, because a Worker needs a window/DOM context that a MV3 service worker does not have.
- Audio is captured by tapping the video element's live playback (`MediaElementAudioSourceNode` plus a `ScriptProcessorNode`), so transcription trails playback by roughly one chunk rather than running arbitrarily far ahead; the `LOOKAHEAD_SECONDS` window governs when capture is active and when the popup reports content as checked, not a true prefetch of unplayed audio.
- `worker.js` imports `@xenova/transformers` from a CDN URL for simplicity. A Chrome Web Store submission should instead vendor the library locally, since the store's policy discourages remotely hosted code; an unpacked/dev load works as shipped.
