/**
 * LinkedIn AI Detector — Scoring Engine (Orchestrator)
 *
 * Calls all 4 scoring layers, sums raw scores, applies post-length
 * normalization and convergence bonus, returns the final result.
 *
 * Layer contributions:
 *   Vocabulary:  max 30 pts (scoreVocabulary)
 *   Structure:   max 30 pts (scoreStructure)
 *   Stylometry:  max 35 pts (scoreStylometry)
 *   LinkedIn:    max 15 pts (scoreLinkedIn)
 *   Raw total:   max 110 pts (capped to 100)
 *
 * Normalization:
 *   < 50 words:  raw × 1.5 (fewer signals = each matters more)
 *   50+ words:   raw × 1.0
 *
 * Convergence bonus:
 *   4+ categories firing: +10 pts
 *   5+ categories firing: +15 pts
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
      stylometry: { score: stylometry.score, max: 35, signals: stylometry.signals, details: stylometry.details },
      linkedin: { score: linkedin.score, max: 15, signals: linkedin.signals, details: linkedin.details }
    },
    topSignals,
    wordCount,
    rawTotal,
    normalizationMultiplier: multiplier,
    convergenceBonus,
    firingCategories
  };
}
