/**
 * LinkedIn AI Detector — Offscreen Document
 * Loads the RoBERTa-based AI text detector via Transformers.js.
 * Runs in an offscreen document to avoid LinkedIn's CSP restrictions.
 */

import { pipeline } from '@huggingface/transformers';

let classifier = null;
let modelLoading = false;
let modelReady = false;

async function loadModel() {
  if (modelLoading || modelReady) return;
  modelLoading = true;

  const startTime = performance.now();
  try {
    classifier = await pipeline(
      'text-classification',
      'onnx-community/roberta-base-openai-detector-ONNX',
      { dtype: 'q8' }
    );
    modelReady = true;
    const elapsed = Math.round(performance.now() - startTime);
    console.log(`[AI Detector ML] Model loaded (${elapsed}ms)`);
  } catch (err) {
    console.error('[AI Detector ML] Failed to load model:', err);
    modelLoading = false;
  }
}

// Start loading the model immediately
loadModel();

// Listen for scoring requests from the background service worker
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== 'ML_SCORE_OFFSCREEN') return false;

  if (!modelReady) {
    sendResponse({ success: false, error: 'Model not ready' });
    return false;
  }

  // Run classifier asynchronously
  (async () => {
    try {
      const results = await classifier(msg.text, { topk: 2 });
      // results is an array of { label, score } sorted by score descending
      const top = results[0];
      console.log(`[AI Detector ML] Scored: ${top.label} (${top.score.toFixed(3)} confidence)`);
      sendResponse({
        success: true,
        label: top.label,
        confidence: top.score
      });
    } catch (err) {
      console.error('[AI Detector ML] Scoring failed:', err);
      sendResponse({ success: false, error: err.message });
    }
  })();

  return true; // keep message channel open for async response
});
