/**
 * LinkedIn AI Detector — Background Service Worker
 * Manages settings, session stats, offscreen document lifecycle,
 * and message relay between content scripts and the ML engine.
 */

const DEFAULT_SETTINGS = {
  enabled: true,
  displayMode: 'badge', // 'badge' | 'badge-expand' | 'off'
  badgeComments: true,  // also badge expanded comments (toggle in popup)
  apiKey: ''
};

const DEFAULT_STATS = {
  postsScanned: 0,
  totalScore: 0,
  bands: { green: 0, amber: 0, red: 0 }
};

// ─── REMOTE SELECTOR CONFIG ───
// Fetch the hosted selectors.json so a LinkedIn DOM change can be fixed by editing
// ONE file — no new extension package, no Web Store review, no user action. This is
// remote DATA (selector strings), not code, so it's MV3/Web-Store compliant. The
// content script ships with the same selectors bundled and uses them whenever this
// fetch hasn't landed, so it's a live-update channel, never a hard dependency.
// To repoint it, change CONFIG_URL (and host_permissions in manifest.json).
const CONFIG_URL = 'https://raw.githubusercontent.com/amankrai28/linkedin-ai-detector/main/selectors.json';
const CONFIG_REFRESH_ALARM = 'laid-config-refresh';

// Shape-check so a malformed (or tampered) file can't blank out detection.
function validateRemoteConfig(cfg) {
  if (!cfg || typeof cfg !== 'object' || !cfg.selectors || typeof cfg.selectors !== 'object') return false;
  const s = cfg.selectors;
  const strOk = (v) => typeof v === 'string' && v.length > 0;
  const feedOk = Array.isArray(s.feedRoot) ? (s.feedRoot.length > 0 && s.feedRoot.every(strOk)) : (s.feedRoot === undefined || strOk(s.feedRoot));
  const itemOk = s.postItem === undefined || strOk(s.postItem);
  const markerOk = s.postMarker === undefined || strOk(s.postMarker);
  // Require at least one real selector and no malformed fields.
  return feedOk && itemOk && markerOk && (s.feedRoot || s.postItem || s.postMarker);
}

async function fetchRemoteConfig() {
  try {
    const res = await fetch(CONFIG_URL, { cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const cfg = await res.json();
    if (!validateRemoteConfig(cfg)) { console.warn('[AI Detector] remote config invalid — keeping current'); return; }
    const prev = (await chrome.storage.local.get('laid_config')).laid_config;
    if (prev && prev.version === cfg.version) return; // unchanged since last fetch
    await chrome.storage.local.set({ laid_config: cfg });
    console.log('[AI Detector] remote selector config updated → v' + cfg.version);
    // Push to any open LinkedIn tabs so they apply it live, no reload needed.
    chrome.tabs.query({ url: 'https://www.linkedin.com/*' }, (tabs) => {
      for (const tab of tabs) chrome.tabs.sendMessage(tab.id, { type: 'CONFIG_UPDATED', config: cfg }).catch(() => {});
    });
  } catch (err) {
    console.warn('[AI Detector] remote config fetch failed (using cached/bundled defaults):', err.message);
  }
}

// ─── OFFSCREEN DOCUMENT MANAGEMENT ───

let creatingOffscreen = null;

async function ensureOffscreenDocument() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });

  if (existingContexts.length > 0) return;

  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }

  creatingOffscreen = chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['WORKERS'],
    justification: 'Run Transformers.js ML model for AI text detection'
  });

  await creatingOffscreen;
  creatingOffscreen = null;
  console.log('[AI Detector] Offscreen document created');
}

// Initialize defaults on install + create offscreen document
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get('settings', (data) => {
    if (!data.settings) {
      chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
    } else if (data.settings.displayMode === 'badge-expand') {
      // Migration: auto-expand mode was removed; reset to badge-only.
      chrome.storage.local.set({
        settings: { ...data.settings, displayMode: 'badge' }
      });
    }
  });
  chrome.storage.session.set({ stats: DEFAULT_STATS });
  ensureOffscreenDocument();
  fetchRemoteConfig();
  try { chrome.alarms.create(CONFIG_REFRESH_ALARM, { periodInMinutes: 360 }); } catch (_) {}
});

// Ensure offscreen document on startup (e.g., browser restart)
chrome.runtime.onStartup.addListener(() => {
  ensureOffscreenDocument();
  fetchRemoteConfig();
  try { chrome.alarms.create(CONFIG_REFRESH_ALARM, { periodInMinutes: 360 }); } catch (_) {}
});

// Periodic refresh so long-lived installs pick up selector fixes without a relaunch.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === CONFIG_REFRESH_ALARM) fetchRemoteConfig();
});

// Handle messages from content script and popup
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'DEV_RELOAD') {
    // Dev-only: reload the unpacked extension from disk so the live-debug loop
    // can iterate code → reload → re-probe without opening chrome://extensions.
    // Guarded to unpacked installs — Web Store builds get an injected
    // `update_url`, so this is a no-op in production even if somehow triggered.
    const isUnpacked = !('update_url' in chrome.runtime.getManifest());
    if (isUnpacked) {
      console.log('[AI Detector] DEV_RELOAD — reloading unpacked extension');
      chrome.runtime.reload();
    }
    return false;
  }

  if (msg.type === 'ML_SCORE_REQUEST') {
    // Relay ML scoring request from content script to offscreen document
    (async () => {
      try {
        await ensureOffscreenDocument();
        const response = await chrome.runtime.sendMessage({
          type: 'ML_SCORE_OFFSCREEN',
          text: msg.text
        });
        sendResponse(response);
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true; // async
  }

  if (msg.type === 'ML_MODEL_READY') {
    console.log('[AI Detector] ML model ready — notifying content scripts');
    chrome.tabs.query({ url: 'https://www.linkedin.com/*' }, (tabs) => {
      for (const tab of tabs) {
        chrome.tabs.sendMessage(tab.id, { type: 'ML_MODEL_READY' }).catch(() => {});
      }
    });
    return false;
  }

  if (msg.type === 'ML_MODEL_STATUS') {
    // Persist latest status so the popup can read it on open
    chrome.storage.session.set({
      lastModelStatus: {
        status: msg.status,
        error: msg.error,
        elapsed: msg.elapsed,
        attempt: msg.attempt,
        nextRetryMs: msg.nextRetryMs,
        ts: Date.now()
      }
    });
    // Relay model loading status from offscreen document to content scripts
    chrome.tabs.query({ url: 'https://www.linkedin.com/*' }, (tabs) => {
      for (const tab of tabs) {
        chrome.tabs.sendMessage(tab.id, msg).catch(() => {});
      }
    });
    return false;
  }

  if (msg.type === 'GET_MODEL_STATUS') {
    chrome.storage.session.get('lastModelStatus', (data) => {
      sendResponse(data.lastModelStatus || { status: 'unknown' });
    });
    return true; // async
  }

  if (msg.type === 'POST_SCORED') {
    // Content script reports a scored post
    chrome.storage.session.get('stats', (data) => {
      const stats = data.stats || DEFAULT_STATS;
      stats.postsScanned++;
      stats.totalScore += msg.score;
      if (msg.score <= 35) stats.bands.green++;
      else if (msg.score <= 65) stats.bands.amber++;
      else stats.bands.red++;
      chrome.storage.session.set({ stats });
    });
    return false;
  }

  if (msg.type === 'GET_STATS') {
    chrome.storage.session.get('stats', (data) => {
      sendResponse(data.stats || DEFAULT_STATS);
    });
    return true; // async
  }

  if (msg.type === 'GET_SETTINGS') {
    chrome.storage.local.get('settings', (data) => {
      // Merge over defaults so setting fields added in a later version (e.g.
      // badgeComments) get their default even for users whose stored settings predate
      // them — otherwise the field reads as undefined and silently behaves as "off".
      sendResponse({ ...DEFAULT_SETTINGS, ...(data.settings || {}) });
    });
    return true;
  }

  if (msg.type === 'UPDATE_SETTINGS') {
    chrome.storage.local.set({ settings: msg.settings }, () => {
      // Notify all LinkedIn tabs about the settings change
      chrome.tabs.query({ url: 'https://www.linkedin.com/*' }, (tabs) => {
        for (const tab of tabs) {
          chrome.tabs.sendMessage(tab.id, {
            type: 'SETTINGS_CHANGED',
            settings: msg.settings
          }).catch(() => {}); // ignore tabs where content script isn't loaded
        }
      });
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.type === 'RESET_STATS') {
    chrome.storage.session.set({ stats: DEFAULT_STATS }, () => {
      sendResponse({ ok: true });
    });
    return true;
  }
});
