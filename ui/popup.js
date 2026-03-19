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
