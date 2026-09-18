function formatTime(sec) {
  const total = Math.max(0, Math.round(Number(sec) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

async function main() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const videoId = tab?.url ? new URL(tab.url).searchParams.get('v') : null;
  const enabledToggle = document.getElementById('enabledToggle');
  const enabledLabel = document.getElementById('enabledLabel');
  const modeRadios = [...document.querySelectorAll('input[name="skipMode"]')];
  const rangesEl = document.getElementById('ranges');
  const rangesTitle = document.getElementById('rangesTitle');
  const rangesCount = document.getElementById('rangesCount');
  const emptyEl = document.getElementById('empty');
  document.getElementById('openSettings').addEventListener('click', () => chrome.runtime.openOptionsPage());

  let settings = ytsbSettings.normalize(await chrome.runtime.sendMessage({ type: 'getSettings' }));

  function renderSettings() {
    const automatic = settings.skipMode !== 'manual';
    enabledToggle.checked = settings.enabled;
    enabledLabel.textContent = settings.enabled ? 'On' : 'Off';
    for (const radio of modeRadios) radio.checked = automatic ? radio.value === 'auto' : radio.value === 'manual';
  }

  async function setSettings(patch) {
    settings = ytsbSettings.normalize(await chrome.runtime.sendMessage({ type: 'setSettings', settings: patch }));
    renderSettings();
  }

  renderSettings();
  enabledToggle.addEventListener('change', () => setSettings({ enabled: enabledToggle.checked }));
  for (const radio of modeRadios) radio.addEventListener('change', () => radio.checked && setSettings({ skipMode: radio.value }));

  if (!videoId) {
    return;
  }

  async function refresh() {
    try {
      const info = await chrome.runtime.sendMessage({ type: 'getPopupInfo', videoId });
      if (info.error) throw new Error(info.error);
      if (info.settings) {
        settings = ytsbSettings.normalize(info.settings);
        renderSettings();
      }
      const ranges = Array.isArray(info.sponsorRanges) ? info.sponsorRanges : [];
      rangesTitle.textContent = ranges.length ? 'Detected sponsors' : 'Sponsor segments';
      rangesCount.textContent = ranges.length ? `${ranges.length} found` : '';
      rangesEl.replaceChildren();
      emptyEl.hidden = ranges.length > 0;
      ranges.forEach((range, index) => {
        const row = document.createElement('div');
        row.className = 'range';
        const text = document.createElement('div');
        const label = document.createElement('span');
        label.className = 'range-label';
        label.textContent = `Sponsor ${index + 1}`;
        const time = document.createElement('span');
        time.className = 'range-time';
        time.textContent = `${formatTime(range.start)} – ${formatTime(range.end)}`;
        text.append(label, time);
        const skipBtn = document.createElement('button');
        skipBtn.type = 'button';
        skipBtn.textContent = 'Skip to end';
        skipBtn.setAttribute('aria-label', `Skip sponsor ${index + 1}`);
        skipBtn.addEventListener('click', () => chrome.tabs.sendMessage(tab.id, { type: 'seekTo', time: range.end }));
        row.append(text, skipBtn);
        rangesEl.appendChild(row);
      });
    } catch (err) {
    }
  }

  await refresh();
  setInterval(refresh, 1000);
}

main().catch(err => {
  console.error('[ytsb] popup failed to load:', err);
});
