const fields = {
  enabled: document.getElementById('enabled'),
  minSkipSeconds: document.getElementById('minSkipSeconds'),
  typesafeApiKey: document.getElementById('typesafeApiKey'),
};
const savedNote = document.getElementById('saved');
let savedTimer = 0;

function render(settings) {
  fields.enabled.checked = settings.enabled;
  fields.minSkipSeconds.value = settings.minSkipSeconds;
  fields.typesafeApiKey.value = settings.typesafeApiKey;
  for (const radio of document.querySelectorAll('input[name="skipMode"]')) {
    radio.checked = radio.value === settings.skipMode;
  }
}

async function save(patch) {
  const settings = await chrome.runtime.sendMessage({ type: 'setSettings', settings: patch });
  // Re-rendered from what the worker stored, so a rejected value never lingers
  // on screen as if it had been accepted.
  render(settings);
  savedNote.classList.add('show');
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => savedNote.classList.remove('show'), 1200);
}

fields.enabled.addEventListener('change', () => save({ enabled: fields.enabled.checked }));
fields.minSkipSeconds.addEventListener('change', () => save({ minSkipSeconds: Number(fields.minSkipSeconds.value) }));
fields.typesafeApiKey.addEventListener('change', () => save({ typesafeApiKey: fields.typesafeApiKey.value }));
for (const radio of document.querySelectorAll('input[name="skipMode"]')) {
  radio.addEventListener('change', () => radio.checked && save({ skipMode: radio.value }));
}
document.getElementById('reset').addEventListener('click', () => save(ytsbSettings.DEFAULTS));

chrome.runtime.sendMessage({ type: 'getSettings' }).then(render);
