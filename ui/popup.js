/**
 * LinkedIn AI Detector — Popup Logic
 * Loads/saves settings via background service worker,
 * displays session stats.
 */

const enableToggle = document.getElementById('enableToggle');
const displayModeRadios = document.querySelectorAll('input[name="displayMode"]');
const apiKeyInput = document.getElementById('apiKey');
const resetStatsBtn = document.getElementById('resetStats');

const statScanned = document.getElementById('statScanned');
const statAvg = document.getElementById('statAvg');
const bandGreen = document.getElementById('bandGreen');
const bandAmber = document.getElementById('bandAmber');
const bandRed = document.getElementById('bandRed');

const modelStatusDot = document.getElementById('modelStatusDot');
const modelStatusLabel = document.getElementById('modelStatusLabel');
const modelStatusDetail = document.getElementById('modelStatusDetail');

// ─── Load settings ───

chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, (settings) => {
  if (!settings) return;
  enableToggle.checked = settings.enabled;
  displayModeRadios.forEach(r => {
    r.checked = r.value === settings.displayMode;
  });
  if (settings.apiKey) {
    apiKeyInput.value = settings.apiKey;
  }
});

// ─── Load stats ───

function loadStats() {
  chrome.runtime.sendMessage({ type: 'GET_STATS' }, (stats) => {
    if (!stats) return;
    statScanned.textContent = stats.postsScanned;
    statAvg.textContent = stats.postsScanned > 0
      ? Math.round(stats.totalScore / stats.postsScanned)
      : '—';
    bandGreen.textContent = stats.bands.green;
    bandAmber.textContent = stats.bands.amber;
    bandRed.textContent = stats.bands.red;
  });
}

loadStats();

// ─── Load ML model status ───

const STALE_LOADING_MS = 60_000;

function renderModelStatus(s) {
  if (!s) s = { status: 'unknown' };
  let status = s.status;

  // A "loading" status older than 60s with no follow-up is probably stuck/stale
  if (status === 'loading' && s.ts && Date.now() - s.ts > STALE_LOADING_MS) {
    status = 'unknown';
  }

  let dotClass = 'gray';
  let label = 'Unknown';
  let detail = '';

  switch (status) {
    case 'loading':
      dotClass = 'amber';
      label = 'Loading…';
      detail = s.attempt > 0 ? `retry ${s.attempt}` : '';
      break;
    case 'retrying':
      dotClass = 'amber';
      label = 'Retrying…';
      detail = s.nextRetryMs ? `next in ${Math.round(s.nextRetryMs / 1000)}s` : '';
      break;
    case 'ready':
      dotClass = 'green';
      label = 'Ready';
      detail = s.elapsed ? `loaded in ${(s.elapsed / 1000).toFixed(1)}s` : '';
      break;
    case 'failed':
      dotClass = 'red';
      label = 'Failed';
      detail = s.error ? String(s.error).slice(0, 40) : '';
      break;
    default:
      dotClass = 'gray';
      label = 'Not yet loaded';
      detail = '';
  }

  modelStatusDot.className = `band-dot ${dotClass}`;
  modelStatusLabel.textContent = label;
  modelStatusDetail.textContent = detail;
}

chrome.runtime.sendMessage({ type: 'GET_MODEL_STATUS' }, renderModelStatus);

// ─── Save settings on change ───

function saveSettings() {
  let displayMode = 'badge';
  displayModeRadios.forEach(r => {
    if (r.checked) displayMode = r.value;
  });

  const settings = {
    enabled: enableToggle.checked,
    displayMode,
    apiKey: apiKeyInput.value.trim()
  };

  chrome.runtime.sendMessage({ type: 'UPDATE_SETTINGS', settings });
}

enableToggle.addEventListener('change', saveSettings);
displayModeRadios.forEach(r => r.addEventListener('change', saveSettings));

// ─── Reset stats ───

resetStatsBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'RESET_STATS' }, () => {
    loadStats();
  });
});
