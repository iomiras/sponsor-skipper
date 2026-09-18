// JSON3 contains both caption events and window/layout events. Keep timed text
// only, and remove repeated rolling-caption prefixes when their times overlap.
function parseCaptions(data, duration) {
  if (!Array.isArray(data.events)) throw new Error('Invalid JSON3 caption document');
  const cues = [];
  for (const event of data.events) {
    const start = event.tStartMs / 1000;
    const end = Math.min(duration, start + event.dDurationMs / 1000);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) continue;
    // segs carry a per-word offset. Keeping it is what lets a sponsor boundary
    // be resolved to the second instead of to the caption block. Words are cut
    // on whitespace across the whole cue, never per seg, because json3 may split
    // one word over two segs and the rolling-text dedup compares word sequences.
    const words = [];
    let atBoundary = true;
    for (const seg of event.segs || []) {
      const raw = seg.utf8 || '';
      if (!raw) continue;
      const segStart = Math.min(end, start + (seg.tOffsetMs || 0) / 1000);
      const parts = raw.split(/\s+/);
      for (let i = 0; i < parts.length; i++) {
        if (!parts[i]) {
          atBoundary = true;
          continue;
        }
        // Only a seg's first part can continue the previous word; later parts
        // were separated by whitespace inside this seg.
        if (i === 0 && !atBoundary && words.length) words.at(-1).text += parts[i];
        else words.push({ text: parts[i], start: segStart });
        atBoundary = false;
      }
      if (/\s$/.test(raw)) atBoundary = true;
    }
    if (words.length) cues.push({ start, end, words, text: words.map((word) => word.text).join(' ') });
  }
  cues.sort((a, b) => a.start - b.start);
  const segments = [];
  let previous = null;
  for (const cue of cues) {
    let words = cue.words;
    if (previous && cue.start < previous.end) {
      const before = previous.words.map((word) => word.text);
      const after = words.map((word) => word.text);
      for (let n = Math.min(before.length, after.length); n > 0; n--) {
        if (before.slice(-n).join(' ') === after.slice(0, n).join(' ')) {
          words = words.slice(n);
          break;
        }
      }
    }
    previous = cue;
    if (!words.length) continue;
    const text = words.map((word) => word.text).join(' ');
    const last = segments.at(-1);
    if (last && cue.start <= last.end + 1 && cue.end - last.start <= 15 && last.text.length + cue.text.length < 700 && !/[.!?]$/.test(last.text)) {
      last.text += ` ${text}`;
      last.words.push(...words);
      last.end = Math.max(last.end, cue.end);
    } else {
      segments.push({ id: `caption-${segments.length}`, start: cue.start, end: cue.end, text, words: [...words] });
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
