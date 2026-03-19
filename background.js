/**
 * LinkedIn AI Detector — Background Service Worker
 * Manages settings, session stats, and message relay.
 */

const DEFAULT_SETTINGS = {
  enabled: true,
  displayMode: 'badge', // 'badge' | 'badge-expand' | 'off'
  apiKey: ''
};

const DEFAULT_STATS = {
  postsScanned: 0,
  totalScore: 0,
  bands: { green: 0, amber: 0, red: 0 }
};

// Initialize defaults on install
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get('settings', (data) => {
    if (!data.settings) {
      chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
    }
  });
  chrome.storage.session.set({ stats: DEFAULT_STATS });
});

// Handle messages from content script and popup
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
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
      sendResponse(data.settings || DEFAULT_SETTINGS);
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
