const assert = require('node:assert/strict');
const { test } = require('node:test');
const { parseCaptions, selectCaptionTrack } = require('../server/captions');
const cue = (start, duration, text) => ({ tStartMs: start, dDurationMs: duration, segs: [{ utf8: text }] });

test('JSON3 parser ignores layout, bounds times and removes overlapping rolling text', () => {
  const result = parseCaptions({ events: [
    { tStartMs: 0, wpWinPosId: 1 }, cue(1000, 3000, 'Get outside'),
    cue(2000, 3000, 'Get outside and enjoy Mountain Dew.'),
    cue(6000, 9000, 'Look for it in stores near you.'), cue(20000, 1000, 'out of bounds'),
  ] }, 10);
  assert.equal(result.length, 2);
  assert.equal(result[0].text, 'Get outside and enjoy Mountain Dew.');
  assert.equal(result[0].start, 1);
  assert.equal(result[1].end, 10);
});

test('repeated text at separate times is not silently deleted', () => {
  const result = parseCaptions({ events: [cue(0, 1000, 'Hello.'), cue(5000, 1000, 'Hello.')] }, 10);
  assert.equal(result.length, 2);
});

test('prefers English manual captions, then original automatic captions', () => {
  const track = (url) => [{ ext: 'json3', url }];
  const info = {
    subtitles: { fr: track('https://www.youtube.com/api/timedtext?lang=fr') },
    automatic_captions: {
      en: track('https://www.youtube.com/api/timedtext?tlang=en'),
      'en-orig': track('https://www.youtube.com/api/timedtext?lang=en'),
    },
  };
  assert.equal(selectCaptionTrack(info).language, 'en-orig');
  info.subtitles.en = track('https://www.youtube.com/api/timedtext?lang=en');
  assert.equal(selectCaptionTrack(info).kind, 'manual');
});
