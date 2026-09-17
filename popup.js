function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function extractVideoId(url) {
  const match = url.match(/[?&]v=([^&]+)/);
  return match ? match[1] : null;
}

async function main() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const videoId = tab?.url ? extractVideoId(tab.url) : null;
  const toggle = document.getElementById('enabledToggle');
  const status = document.getElementById('status');
  const rangesEl = document.getElementById('ranges');
  const emptyEl = document.getElementById('empty');

  const { enabled } = await chrome.runtime.sendMessage({ type: 'getEnabled' });
  toggle.checked = enabled;
  toggle.addEventListener('change', () => {
    chrome.runtime.sendMessage({ type: 'setEnabled', enabled: toggle.checked });
  });

  if (!videoId) {
    status.textContent = 'Not on a video page.';
    return;
  }

  const info = await chrome.runtime.sendMessage({ type: 'getPopupInfo', videoId });
  status.textContent = `Checked up to ${formatTime(info.checkedUpTo)}`;

  if (info.sponsorRanges.length === 0) {
    emptyEl.style.display = 'block';
    return;
  }
  emptyEl.style.display = 'none';

  for (const range of info.sponsorRanges) {
    const row = document.createElement('div');
    row.className = 'range';
    const label = document.createElement('span');
    label.textContent = `${formatTime(range.start)} - ${formatTime(range.end)}`;
    const skipBtn = document.createElement('button');
    skipBtn.textContent = 'Skip now';
    skipBtn.addEventListener('click', () => {
      chrome.tabs.sendMessage(tab.id, { type: 'seekTo', time: range.end });
    });
    row.appendChild(label);
    row.appendChild(skipBtn);
    rangesEl.appendChild(row);
  }
}

main();
