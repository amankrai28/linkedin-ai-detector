/**
 * LinkedIn AI Detector — Layer 3: Stylometric Analysis
 * Max score: 25 points
 *
 * Statistical writing behavior analysis:
 *   Sentence length variance: 0–8 pts
 *   Em dash density: 0–4 pts
 *   Paragraph length uniformity: 0–4 pts
 *   Hedging density: 0–4 pts
 *   Perfect grammar signal: 0–3 pts
 *   Superficial -ing phrases: 0–2 pts
 */

const STYLOMETRY_MAX = 25;

// ─── HELPERS ───

function getWords(text) {
  return text.split(/\s+/).filter(w => w.length > 0);
}

function getSentences(text) {
  return text
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

function getParagraphs(text) {
  return text
    .split(/\n\s*\n|\n/)
    .map(p => p.trim())
    .filter(p => p.length > 0);
}

function coefficientOfVariation(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean === 0) return 0;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}

// ─── DETECTORS ───

function detectSentenceLengthVariance(text) {
  const sentences = getSentences(text);
  if (sentences.length < 4) return { score: 0, signals: [] };

  const lengths = sentences.map(s => getWords(s).length);
  const cv = coefficientOfVariation(lengths);

  if (cv < 0.3) {
    return {
      score: 8,
      signals: [`Very uniform sentence lengths (CV=${cv.toFixed(2)}) — AI-like`]
    };
  }
  if (cv <= 0.5) {
    return {
      score: 4,
      signals: [`Moderately uniform sentence lengths (CV=${cv.toFixed(2)})`]
    };
  }
  return { score: 0, signals: [] };
}

function detectEmDashDensity(text) {
  const wordCount = getWords(text).length;
  if (wordCount === 0) return { score: 0, signals: [] };

  // Count em dashes (—) and en dashes used as em dashes (--)
  const emDashes = (text.match(/—|--/g) || []).length;
  const per100 = (emDashes / wordCount) * 100;

  if (per100 >= 4) {
    return {
      score: 4,
      signals: [`Heavy em dash usage: ${emDashes} dashes in ${wordCount} words (${per100.toFixed(1)}/100)`]
    };
  }
  if (per100 >= 2) {
    return {
      score: 2,
      signals: [`Elevated em dash usage: ${emDashes} dashes in ${wordCount} words (${per100.toFixed(1)}/100)`]
    };
  }
  return { score: 0, signals: [] };
}

function detectParagraphUniformity(text) {
  const paragraphs = getParagraphs(text);
  if (paragraphs.length < 3) return { score: 0, signals: [] };

  const lengths = paragraphs.map(p => getWords(p).length);
  const cv = coefficientOfVariation(lengths);

  if (cv < 0.3) {
    return {
      score: 4,
      signals: [`Very uniform paragraph lengths (CV=${cv.toFixed(2)}) — AI-like`]
    };
  }
  if (cv <= 0.5) {
    return {
      score: 2,
      signals: [`Moderately uniform paragraph lengths (CV=${cv.toFixed(2)})`]
    };
  }
  return { score: 0, signals: [] };
}

function detectHedgingDensity(text) {
  const lower = text.toLowerCase();
  const wordCount = getWords(text).length;
  if (wordCount === 0) return { score: 0, signals: [] };

  const hedges = [
    'perhaps', 'it could be argued', 'potentially', 'it might be said',
    'arguably', 'it is possible', 'one could argue', 'it may be',
    'it seems', 'it appears'
  ];

  let count = 0;
  for (const h of hedges) {
    const re = new RegExp(h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    const matches = lower.match(re);
    if (matches) count += matches.length;
  }

  const per100 = (count / wordCount) * 100;

  if (per100 > 3) {
    return {
      score: 4,
      signals: [`High hedging density: ${count} hedges in ${wordCount} words (${per100.toFixed(1)}/100)`]
    };
  }
  if (per100 >= 2) {
    return {
      score: 2,
      signals: [`Elevated hedging: ${count} hedges in ${wordCount} words`]
    };
  }
  return { score: 0, signals: [] };
}

function detectPerfectGrammar(text) {
  const wordCount = getWords(text).length;
  if (wordCount < 100) return { score: 0, signals: [] };

  const contractions = [
    "don't", "can't", "won't", "I'm", "I've", "I'll", "I'd",
    "we're", "we've", "they're", "they've", "isn't", "aren't",
    "wasn't", "weren't", "hasn't", "haven't", "hadn't", "doesn't",
    "didn't", "couldn't", "wouldn't", "shouldn't", "it's", "that's",
    "there's", "here's", "what's", "who's", "let's"
  ];

  const hasContraction = contractions.some(c => text.toLowerCase().includes(c));

  if (!hasContraction) {
    // Check that context appears casual (LinkedIn posts are inherently casual)
    // Exclude if it looks like a formal announcement or legal text
    const formalMarkers = ['hereby', 'pursuant', 'whereas', 'aforementioned', 'hereunder'];
    const isFormal = formalMarkers.some(m => text.toLowerCase().includes(m));

    if (!isFormal) {
      return {
        score: 3,
        signals: [`Zero contractions in ${wordCount}+ word casual post — suspiciously formal`]
      };
    }
  }
  return { score: 0, signals: [] };
}

function detectSuperficialIng(text) {
  const ingWords = [
    'highlighting', 'underscoring', 'emphasizing', 'reflecting',
    'showcasing', 'ensuring', 'symbolizing', 'cultivating',
    'fostering', 'encompassing'
  ];

  // Look for these -ing words used as trailing participial phrases
  // e.g. ", highlighting the importance of..." or "— showcasing their..."
  let count = 0;
  const lower = text.toLowerCase();
  for (const w of ingWords) {
    // Match the -ing word preceded by comma, dash, or start of sentence
    const re = new RegExp('(?:,\\s*|—\\s*|^\\s*)' + w + '\\b', 'gim');
    const matches = lower.match(re);
    if (matches) count += matches.length;
  }

  if (count >= 2) {
    return { score: 2, signals: [`${count} superficial -ing constructions detected`] };
  }
  if (count === 1) {
    return { score: 1, signals: ['1 superficial -ing construction detected'] };
  }
  return { score: 0, signals: [] };
}

// ─── MAIN SCORER ───

function scoreStylometry(text) {
  const results = [
    detectSentenceLengthVariance(text),
    detectEmDashDensity(text),
    detectParagraphUniformity(text),
    detectHedgingDensity(text),
    detectPerfectGrammar(text),
    detectSuperficialIng(text)
  ];

  const signals = [];
  const details = {};
  let rawTotal = 0;

  const names = [
    'sentenceLengthVariance', 'emDashDensity', 'paragraphUniformity',
    'hedgingDensity', 'perfectGrammar', 'superficialIng'
  ];

  results.forEach((r, i) => {
    rawTotal += r.score;
    signals.push(...r.signals);
    details[names[i]] = r.score;
  });

  const score = Math.min(rawTotal, STYLOMETRY_MAX);
  return { score, signals, details };
}
