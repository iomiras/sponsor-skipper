function formatTime(sec) {
  return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
}

async function main() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const videoId = tab?.url ? new URL(tab.url).searchParams.get('v') : null;
  const toggle = document.getElementById('enabledToggle');
  const status = document.getElementById('status');
  const rangesEl = document.getElementById('ranges');
  const emptyEl = document.getElementById('empty');
  const modeEl = document.getElementById('mode');
  const toggleMode = document.getElementById('toggleMode');
  document.getElementById('openSettings').addEventListener('click', () => chrome.runtime.openOptionsPage());

  let settings = await chrome.runtime.sendMessage({ type: 'getSettings' });
  const showSettings = () => {
    toggle.checked = settings.enabled;
    const manual = settings.skipMode === 'manual';
    modeEl.textContent = manual ? 'Manual button mode' : 'Automatic mode';
    toggleMode.textContent = manual ? 'Use automatic skipping' : 'Use manual button';
  };
  showSettings();
  toggle.addEventListener('change', async () => {
    settings = await chrome.runtime.sendMessage({ type: 'setSettings', settings: { enabled: toggle.checked } });
    showSettings();
  });
  toggleMode.addEventListener('click', async () => {
    settings = await chrome.runtime.sendMessage({ type: 'setSettings', settings: { skipMode: settings.skipMode === 'manual' ? 'auto' : 'manual' } });
    showSettings();
  });
  if (!videoId) { status.textContent = 'Not on a video page.'; return; }

  async function refresh() {
    try {
      const [info, playback] = await Promise.all([
        chrome.runtime.sendMessage({ type: 'getPopupInfo', videoId }),
        chrome.tabs.sendMessage(tab.id, { type: 'getPlaybackStatus' }),
      ]);
      if (info.error) throw new Error(info.error);
      if (!toggle.checked) status.textContent = 'Sponsor skipping is off.';
      else if (playback.error) status.textContent = `Analysis will retry: ${playback.error}`;
      else if (!info.source) status.textContent = 'Analyzing in the background…';
      else {
        const end = ytsbTimeline.checkedEnd(info.processedChunks, playback.position);
        const source = info.source === 'captions' ? 'Captions' : 'Audio fallback';
        status.textContent = `${source} · ${Math.max(0, Math.floor(end - playback.position))}s checked ahead (to ${formatTime(end)})`;
      }
      rangesEl.replaceChildren();
      emptyEl.hidden = info.sponsorRanges.length > 0;
      for (const range of info.sponsorRanges) {
        const row = document.createElement('div');
        row.className = 'range';
        const label = document.createElement('span');
        label.textContent = `${formatTime(range.start)} – ${formatTime(range.end)}`;
        const skipBtn = document.createElement('button');
        skipBtn.textContent = 'Skip now';
        skipBtn.addEventListener('click', () => chrome.tabs.sendMessage(tab.id, { type: 'seekTo', time: range.end }));
        row.append(label, skipBtn);
        rangesEl.appendChild(row);
      }
    } catch (err) {
      status.textContent = `Refresh the YouTube tab to connect: ${err.message}`;
    }
  }
  await refresh();
  setInterval(refresh, 1000);
}
main().catch(err => { document.getElementById('status').textContent = err.message; });
