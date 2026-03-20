/**
 * LinkedIn AI Detector — Scoring Engine (Orchestrator)
 *
 * Combines ML model scores with heuristic scores using a Noisy-OR model
 * from probability theory: P(AI) = 1 - (1 - H/100)(1 - M/100).
 * This treats each detector as an independent evidence source — neither
 * can drag down the other, and convergence amplifies the signal.
 *
 * Falls back to heuristic-only scoring when the ML model is not yet loaded.
 *
 * Heuristic layer contributions:
 *   Vocabulary:  max 30 pts (scoreVocabulary)
 *   Structure:   max 30 pts (scoreStructure)
 *   Stylometry:  max 38 pts (scoreStylometry)
 *   LinkedIn:    max 15 pts (scoreLinkedIn)
 *   Raw total:   max 113 pts (capped to 100)
 *
 * Short post handling (< 100 words):
 *   Statistical detectors (burstiness, lexical diversity, sentence variance,
 *   paragraph uniformity) are zeroed out — not enough data.
 *   Result includes partial: true flag.
 *
 * Normalization:
 *   < 50 words:  raw × 1.5 (fewer signals = each matters more)
 *   50+ words:   raw × 1.0
 *
 * Convergence bonus:
 *   4+ categories firing: +10 pts
 *   5+ categories firing: +15 pts
 */

/**
 * Runs the heuristic scoring engine (synchronous).
 * This is the original scorePost logic, preserved as-is.
 */
function scorePostHeuristic(text) {
  if (!text || text.trim().length === 0) {
    return {
      score: 0,
      layers: {
        vocabulary: { score: 0, signals: [], details: {} },
        structure: { score: 0, signals: [], details: {} },
        stylometry: { score: 0, signals: [], details: {} },
        linkedin: { score: 0, signals: [], details: {} }
      },
      topSignals: [],
      wordCount: 0,
      normalizationMultiplier: 1
    };
  }

  const wordCount = text.split(/\s+/).filter(w => w.length > 0).length;

  // Run all 4 layers
  const vocabulary = scoreVocabulary(text);
  const structure = scoreStructure(text);
  const stylometry = scoreStylometry(text);
  const linkedin = scoreLinkedIn(text);

  // Short-post gating: zero out statistical detectors that need more data
  const partial = wordCount < 100;
  if (partial) {
    const skipKeys = ['burstiness', 'lexicalDiversity', 'sentenceLengthVariance', 'paragraphUniformity'];
    for (const key of skipKeys) {
      if (stylometry.details[key] > 0) {
        stylometry.score -= stylometry.details[key];
        stylometry.details[key] = 0;
      }
    }
    // Remove signals related to skipped detectors
    const skipPatterns = ['burstiness', 'type-token', 'sentence lengths', 'paragraph lengths'];
    stylometry.signals = stylometry.signals.filter(s => {
      const lower = s.toLowerCase();
      return !skipPatterns.some(p => lower.includes(p));
    });
  }

  const rawTotal = vocabulary.score + structure.score + stylometry.score + linkedin.score;

  // Post-length normalization (no penalty for long posts)
  let multiplier = 1;
  if (wordCount < 50) {
    multiplier = 1.5;
  }

  const normalized = Math.round(rawTotal * multiplier);

  // Convergence bonus: multiple independent detection categories firing
  // together is strong evidence of AI generation
  const firingCategories = [
    vocabulary.score > 0,
    structure.score > 0,
    stylometry.score > 0,
    linkedin.score > 0,
    // Count sub-categories within layers as separate categories
    vocabulary.details.tier1.raw > 0,
    vocabulary.details.tier2.raw > 0,
    vocabulary.details.tier3.raw > 0,
    vocabulary.details.coOccurrence.raw > 0,
    structure.details.broetry > 0,
    structure.details.hookStoryLessonCTA > 0,
    structure.details.negativeParallelisms > 0,
    structure.details.ruleOfThree > 0,
    stylometry.details.sentenceLengthVariance > 0,
    stylometry.details.burstiness > 0,
    stylometry.details.lexicalDiversity > 0,
    stylometry.details.sentenceStarterRepetition > 0,
    linkedin.details.scrollManipulation > 0,
    linkedin.details.emojiAsStructure > 0
  ].filter(Boolean).length;

  let convergenceBonus = 0;
  if (firingCategories >= 5) {
    convergenceBonus = 15;
  } else if (firingCategories >= 4) {
    convergenceBonus = 10;
  }

  const finalScore = Math.min(normalized + convergenceBonus, 100);

  // Collect top signals across all layers (up to 6)
  const allSignals = [
    ...vocabulary.signals,
    ...structure.signals,
    ...stylometry.signals,
    ...linkedin.signals
  ];
  if (convergenceBonus > 0) {
    allSignals.push(`Convergence bonus: ${firingCategories} categories firing (+${convergenceBonus})`);
  }
  const topSignals = allSignals.slice(0, 6);

  return {
    score: finalScore,
    layers: {
      vocabulary: { score: vocabulary.score, max: 30, signals: vocabulary.signals, details: vocabulary.details },
      structure: { score: structure.score, max: 30, signals: structure.signals, details: structure.details },
      stylometry: { score: stylometry.score, max: 38, signals: stylometry.signals, details: stylometry.details },
      linkedin: { score: linkedin.score, max: 15, signals: linkedin.signals, details: linkedin.details }
    },
    topSignals,
    wordCount,
    rawTotal,
    normalizationMultiplier: multiplier,
    convergenceBonus,
    firingCategories,
    partial
  };
}

/**
 * Main scoring function — combines ML model with heuristic engine using
 * Noisy-OR: P(AI) = 1 - (1 - H/100)(1 - M/100).
 * Falls back to heuristic-only when ML model is unavailable.
 *
 * @param {string} text - The post text to score
 * @returns {Promise<object>} Scoring result with blended score
 */
async function scorePost(text) {
  // Normalize Unicode: converts mathematical bold/italic (common in LinkedIn
  // formatting) to standard ASCII so both the ML tokenizer and heuristic
  // patterns can match them.
  text = text.normalize('NFKC');

  // Run heuristic engine (synchronous, instant)
  const heuristicResult = scorePostHeuristic(text);

  // Attempt ML scoring (async, may take 200-500ms)
  let mlResult = null;
  if (typeof mlScore === 'function') {
    try {
      mlResult = await mlScore(text);
    } catch (e) {
      mlResult = { score: 0, available: false };
    }
  }

  const mlAvailable = mlResult && mlResult.available;
  let finalScore;

  if (mlAvailable) {
    // Noisy-OR: treats detectors as independent evidence sources.
    // P(AI) = 1 - (1 - H/100)(1 - M/100)
    // Neither detector can drag down the other; convergence amplifies.
    const h = heuristicResult.score / 100;
    const m = mlResult.score / 100;
    finalScore = Math.round((1 - (1 - h) * (1 - m)) * 100);
  } else {
    // ML not available — heuristic only (equivalent to Noisy-OR with M=0)
    finalScore = heuristicResult.score;
  }

  return {
    // Primary score field (backward compatible — overlay.js uses result.score)
    score: finalScore,
    // Existing fields (backward compatible)
    layers: heuristicResult.layers,
    topSignals: heuristicResult.topSignals,
    wordCount: heuristicResult.wordCount,
    rawTotal: heuristicResult.rawTotal,
    normalizationMultiplier: heuristicResult.normalizationMultiplier,
    convergenceBonus: heuristicResult.convergenceBonus,
    firingCategories: heuristicResult.firingCategories,
    partial: heuristicResult.partial,
    // New ML-related fields
    mlScore: mlAvailable ? mlResult.score : null,
    mlConfidence: mlAvailable ? mlResult.confidence : null,
    mlLabel: mlAvailable ? mlResult.label : null,
    heuristicScore: heuristicResult.score,
    mlAvailable: !!mlAvailable,
    blendMode: mlAvailable ? 'noisy-or' : 'heuristic-only'
  };
}
