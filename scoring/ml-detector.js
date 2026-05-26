/**
 * LinkedIn AI Detector — ML Detector (Content Script)
 * Sends text to the background service worker for ML scoring
 * via the offscreen document running Transformers.js.
 */

// eslint-disable-next-line no-unused-vars
async function mlScore(text) {
  // Single attempt — no retries. When the ML model finishes loading,
  // the ML_MODEL_READY message triggers a full re-score of all posts
  // (see content.js), so retrying here would just block the UI.
  try {
    // Preprocess: strip LinkedIn noise (emojis, URLs, hashtags, @mentions)
    const cleaned = typeof preprocessForML === 'function' ? preprocessForML(text) : text;

    const response = await chrome.runtime.sendMessage({
      type: 'ML_SCORE_REQUEST',
      text: cleaned
    });

    if (response && response.success) {
      // Fakespot model returns { label: 'AI'|'Human', score: 0-1 }
      const aiScore = response.label === 'AI'
        ? Math.round(response.confidence * 100)
        : Math.round((1 - response.confidence) * 100);

      return {
        score: aiScore,
        confidence: response.confidence,
        label: response.label,
        available: true
      };
    }

    return { score: 0, available: false };
  } catch (e) {
    return { score: 0, available: false };
  }
}
