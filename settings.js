// Shared by the background worker, player controller, options page and tests.
// One stored object, normalized on every read, so a partial or stale write can
// never leave the player controller acting on an undefined mode.
(function (root) {
  const SETTINGS_KEY = 'ytsb:settings';
  const DEFAULTS = { enabled: true, skipMode: 'manual', minSkipSeconds: 1, typesafeApiKey: '' };

  function normalize(stored) {
    const merged = { ...DEFAULTS, ...(stored && typeof stored === 'object' ? stored : {}) };
    const minSkipSeconds = Number(merged.minSkipSeconds);
    const typesafeApiKey = typeof merged.typesafeApiKey === 'string' ? merged.typesafeApiKey.trim() : '';
    return {
      enabled: merged.enabled !== false,
      skipMode: merged.skipMode === 'auto' ? 'auto' : 'manual',
      minSkipSeconds: Number.isFinite(minSkipSeconds) ? Math.min(60, Math.max(0, minSkipSeconds)) : DEFAULTS.minSkipSeconds,
      typesafeApiKey,
    };
  }

  // A one-second detection is more jarring to skip than to watch, so ranges
  // shorter than the setting are reported but never acted on.
  function actionableRanges(ranges, settings) {
    const minimum = normalize(settings).minSkipSeconds;
    return (ranges || []).filter((range) => range.end - range.start >= minimum);
  }

  const api = { SETTINGS_KEY, DEFAULTS, normalize, actionableRanges };
  if (typeof module !== 'undefined') module.exports = api;
  else root.ytsbSettings = api;
})(globalThis);
