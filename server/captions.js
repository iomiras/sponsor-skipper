// JSON3 contains both caption events and window/layout events. Keep timed text
// only, and remove repeated rolling-caption prefixes when their times overlap.
function parseCaptions(data, duration) {
  if (!Array.isArray(data.events)) throw new Error('Invalid JSON3 caption document');
  const cues = [];
  for (const event of data.events) {
    const text = (event.segs || []).map((seg) => seg.utf8 || '').join('').replace(/\s+/g, ' ').trim();
    const start = event.tStartMs / 1000;
    const end = Math.min(duration, start + event.dDurationMs / 1000);
    if (!text || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) continue;
    cues.push({ start, end, text });
  }
  cues.sort((a, b) => a.start - b.start);
  const segments = [];
  let previous = null;
  for (const cue of cues) {
    let words = cue.text.split(' ');
    if (previous && cue.start < previous.end) {
      const before = previous.text.split(' ');
      for (let n = Math.min(before.length, words.length); n > 0; n--) {
        if (before.slice(-n).join(' ') === words.slice(0, n).join(' ')) {
          words = words.slice(n);
          break;
        }
      }
    }
    previous = cue;
    if (!words.length) continue;
    const last = segments.at(-1);
    if (last && cue.start <= last.end + 1 && cue.end - last.start <= 15 && last.text.length + cue.text.length < 700 && !/[.!?]$/.test(last.text)) {
      last.text += ` ${words.join(' ')}`;
      last.end = Math.max(last.end, cue.end);
    } else {
      segments.push({ id: `caption-${segments.length}`, start: cue.start, end: cue.end, text: words.join(' ') });
    }
  }
  return segments;
}

function selectCaptionTrack(info) {
  const tracks = [];
  for (const [kind, collection] of [['manual', info.subtitles], ['automatic', info.automatic_captions]]) {
    for (const [language, formats] of Object.entries(collection || {})) {
      if (language === 'live_chat') continue;
      const track = formats.find((format) => format.ext === 'json3' && format.url);
      if (!track) continue;
      // Prefer English creator captions, then original English auto captions.
      // Avoid automatically translated tracks when an original track exists.
      const english = /^en(?:-|$)/.test(language);
      const translated = new URL(track.url).searchParams.has('tlang');
      const score = (translated ? 100 : 0) + (english ? 0 : 20) + (kind === 'manual' ? 0 : 5) - (language.endsWith('-orig') ? 1 : 0);
      tracks.push({ ...track, language, kind, score });
    }
  }
  return tracks.sort((a, b) => a.score - b.score)[0] || null;
}

module.exports = { parseCaptions, selectCaptionTrack };
