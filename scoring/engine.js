/**
 * LinkedIn AI Detector — Scoring Engine (Orchestrator)
 *
 * Calls all 4 scoring layers, sums raw scores, applies post-length
 * normalization, and returns the final result.
 *
 * Layer contributions:
 *   Vocabulary:  max 30 pts (scoreVocabulary)
 *   Structure:   max 30 pts (scoreStructure)
 *   Stylometry:  max 25 pts (scoreStylometry)
 *   LinkedIn:    max 15 pts (scoreLinkedIn)
 *   Raw total:   max 100 pts
 *
 * Normalization:
 *   < 50 words:    raw × 1.5 (fewer signals = each matters more)
 *   50–200 words:  raw × 1.0
 *   > 200 words:   raw × 0.85 (more words = more false positives)
 *   Final capped at 100
 */

function scorePost(text) {
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

  const rawTotal = vocabulary.score + structure.score + stylometry.score + linkedin.score;

  // Post-length normalization
  let multiplier = 1;
  if (wordCount < 50) {
    multiplier = 1.5;
  } else if (wordCount > 200) {
    multiplier = 0.85;
  }

  const normalized = Math.round(rawTotal * multiplier);
  const finalScore = Math.min(normalized, 100);

  // Collect top signals across all layers (up to 6)
  const allSignals = [
    ...vocabulary.signals,
    ...structure.signals,
    ...stylometry.signals,
    ...linkedin.signals
  ];
  const topSignals = allSignals.slice(0, 6);

  return {
    score: finalScore,
    layers: {
      vocabulary: { score: vocabulary.score, max: 30, signals: vocabulary.signals, details: vocabulary.details },
      structure: { score: structure.score, max: 30, signals: structure.signals, details: structure.details },
      stylometry: { score: stylometry.score, max: 25, signals: stylometry.signals, details: stylometry.details },
      linkedin: { score: linkedin.score, max: 15, signals: linkedin.signals, details: linkedin.details }
    },
    topSignals,
    wordCount,
    rawTotal,
    normalizationMultiplier: multiplier
  };
}
