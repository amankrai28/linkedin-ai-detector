/**
 * LinkedIn AI Detector — Offscreen Document
 * Loads the RoBERTa-based AI text detector via Transformers.js.
 * Runs in an offscreen document to avoid LinkedIn's CSP restrictions.
 */

import { pipeline, env } from '@huggingface/transformers';

// Configure ONNX Runtime for Chrome extension context
try {
  env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('build/');
  env.backends.onnx.wasm.numThreads = 1;
} catch (e) {
  console.warn('[AI Detector ML] Could not configure ONNX wasm env:', e.message);
}
env.allowLocalModels = false;
env.useFSCache = false;

let classifier = null;
let modelLoading = false;
let modelReady = false;

const LOAD_TIMEOUT = 60_000; // 60 seconds

async function loadModel() {
  if (modelLoading || modelReady) return;
  modelLoading = true;

  console.log('[AI Detector ML] Loading model...');
  const startTime = performance.now();
  try {
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Model load timed out after 60s')), LOAD_TIMEOUT)
    );
    classifier = await Promise.race([
      pipeline(
        'text-classification',
        'onnx-community/roberta-base-openai-detector-ONNX',
        { dtype: 'q8' }
      ),
      timeout
    ]);
    modelReady = true;
    const elapsed = Math.round(performance.now() - startTime);
    console.log(`[AI Detector ML] Model loaded (${elapsed}ms)`);
    // Notify background so content scripts can re-score posts
    chrome.runtime.sendMessage({ type: 'ML_MODEL_READY' }).catch(() => {});
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
