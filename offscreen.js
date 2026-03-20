/**
 * LinkedIn AI Detector — Offscreen Document
 * Loads the RoBERTa-based AI text detector via Transformers.js.
 * Runs in an offscreen document to avoid LinkedIn's CSP restrictions.
 */

import { pipeline, env } from '@huggingface/transformers';

// Configure ONNX Runtime for Chrome extension context
try {
  env.backends.onnx.wasm.wasmPaths = {
    mjs: chrome.runtime.getURL('build/ort-wasm-simd-threaded.jsep.mjs'),
    wasm: chrome.runtime.getURL('build/ort-wasm-simd-threaded.jsep.wasm')
  };
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
const MODEL_RETRIES = 2;
const RETRY_DELAY = 5000; // 5 seconds base

function relayStatus(status, extra = {}) {
  chrome.runtime.sendMessage({
    type: 'ML_MODEL_STATUS',
    status,
    ...extra
  }).catch(() => {});
}

async function loadModel(attempt = 0) {
  if (modelLoading || modelReady) return;
  modelLoading = true;

  console.log('[AI Detector ML] Loading model...');
  relayStatus('loading', { attempt });
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
    relayStatus('ready', { elapsed });
    // Notify background so content scripts can re-score posts
    chrome.runtime.sendMessage({ type: 'ML_MODEL_READY' }).catch(() => {});
  } catch (err) {
    console.error('[AI Detector ML] Failed to load model:', err);
    modelLoading = false;

    if (attempt < MODEL_RETRIES) {
      const delay = RETRY_DELAY * Math.pow(2, attempt);
      console.log(`[AI Detector ML] Retrying in ${delay / 1000}s (attempt ${attempt + 1}/${MODEL_RETRIES})...`);
      relayStatus('retrying', { attempt: attempt + 1, error: err.message, nextRetryMs: delay });
      setTimeout(() => loadModel(attempt + 1), delay);
    } else {
      console.error('[AI Detector ML] All retries exhausted. Model unavailable.');
      relayStatus('failed', { error: err.message });
    }
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
