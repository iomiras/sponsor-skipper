const assert = require('node:assert/strict');
const { test } = require('node:test');
const settings = require('../settings');

test('manual sponsor confirmation is the default', () => {
  assert.equal(settings.DEFAULTS.skipMode, 'manual');
  assert.equal(settings.normalize({}).skipMode, 'manual');
  assert.equal(settings.normalize({ skipMode: 'auto' }).skipMode, 'auto');
});
