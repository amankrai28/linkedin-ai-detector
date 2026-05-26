/**
 * LinkedIn AI Detector — Layer 3: Stylometric Analysis
 * Max score: 35 points
 *
 * Statistical writing behavior analysis:
 *   Sentence length variance: 0–8 pts
 *   Em dash density: 0–4 pts
 *   Paragraph length uniformity: 0–4 pts
 *   Hedging density: 0–4 pts
 *   Perfect grammar signal: 0–3 pts
 *   Superficial -ing phrases: 0–2 pts
 *   Burstiness (complexity variance): 0–8 pts
 *   Lexical diversity (TTR + transitions): 0–5 pts
 *   Sentence starter repetition: 0–5 pts
 */

const STYLOMETRY_MAX = 38;

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

function detectBurstiness(text) {
  const sentences = getSentences(text);
  if (sentences.length < 5) return { score: 0, signals: [] };

  // Per-sentence complexity: wordCount * avgWordLength * punctuationCount
  const complexities = sentences.map(s => {
    const words = getWords(s);
    if (words.length === 0) return 0;
    const avgWordLen = words.reduce((sum, w) => sum + w.length, 0) / words.length;
    const punctCount = (s.match(/[,;:!?\-—"'()]/g) || []).length + 1; // +1 to avoid zero
    return words.length * avgWordLen * punctCount;
  });

  const mean = complexities.reduce((a, b) => a + b, 0) / complexities.length;
  if (mean === 0) return { score: 0, signals: [] };

  const variance = complexities.reduce((sum, v) => sum + (v - mean) ** 2, 0) / complexities.length;
  const stdDev = Math.sqrt(variance);
  const burstiness = stdDev / mean;

  if (burstiness < 0.3) {
    return {
      score: 8,
      signals: [`Low burstiness (${burstiness.toFixed(2)}) — robotically consistent complexity`]
    };
  }
  if (burstiness <= 0.5) {
    return {
      score: 4,
      signals: [`Medium burstiness (${burstiness.toFixed(2)}) — somewhat uniform complexity`]
    };
  }
  return { score: 0, signals: [] };
}

function detectLexicalDiversity(text) {
  const words = getWords(text).map(w => w.toLowerCase().replace(/[^a-z']/g, '')).filter(w => w.length > 0);
  if (words.length === 0) return { score: 0, signals: [] };

  let score = 0;
  const signals = [];

  // Stop words to exclude from TTR
  const stopWords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for',
    'on', 'with', 'at', 'by', 'from', 'as', 'into', 'about', 'through',
    'after', 'before', 'between', 'under', 'above', 'and', 'but', 'or',
    'not', 'no', 'nor', 'so', 'yet', 'both', 'either', 'neither', 'each',
    'every', 'all', 'any', 'few', 'more', 'most', 'other', 'some', 'such',
    'than', 'too', 'very', 'just', 'also', 'then', 'that', 'this', 'these',
    'those', 'it', 'its', 'i', 'me', 'my', 'we', 'our', 'you', 'your',
    'he', 'him', 'his', 'she', 'her', 'they', 'them', 'their', 'what',
    'which', 'who', 'whom', 'how', 'when', 'where', 'why', 'if', 'because'
  ]);

  const contentWords = words.filter(w => !stopWords.has(w));
  if (contentWords.length > 0 && words.length > 200) {
    const uniqueWords = new Set(contentWords);
    const ttr = uniqueWords.size / contentWords.length;
    if (ttr < 0.4) {
      score += 3;
      signals.push(`Low type-token ratio (${ttr.toFixed(2)}) — repetitive vocabulary`);
    }
  }

  // Transition word repetition
  const transitionWords = [
    'additionally', 'furthermore', 'moreover', 'in addition',
    'however', 'that said', 'on the other hand'
  ];
  const lower = text.toLowerCase();
  let distinctTransitions = 0;
  let maxRepeat = 0;
  for (const tw of transitionWords) {
    const re = new RegExp('\\b' + tw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi');
    const matches = lower.match(re);
    if (matches) {
      distinctTransitions++;
      if (matches.length > maxRepeat) maxRepeat = matches.length;
    }
  }

  if (distinctTransitions >= 3 || maxRepeat >= 3) {
    score += 5;
    signals.push(`Heavy transition words: ${distinctTransitions} distinct, max repeated ${maxRepeat}x`);
  } else if (distinctTransitions >= 2 || maxRepeat >= 2) {
    score += 3;
    signals.push(`Moderate transition words: ${distinctTransitions} distinct, max repeated ${maxRepeat}x`);
  }

  return { score: Math.min(score, 5), signals };
}

function detectSentenceStarterRepetition(text) {
  const sentences = getSentences(text);
  if (sentences.length < 5) return { score: 0, signals: [] };

  // Extract first 2 words of each sentence (lowercased)
  const starters = sentences.map(s => {
    const words = getWords(s).slice(0, 2).map(w => w.toLowerCase());
    return words.join(' ');
  }).filter(s => s.length > 0);

  if (starters.length < 5) return { score: 0, signals: [] };

  // Count occurrences of each starter pattern
  const counts = {};
  for (const starter of starters) {
    counts[starter] = (counts[starter] || 0) + 1;
  }

  // Find the most repeated starter
  let maxCount = 0;
  let maxStarter = '';
  for (const [starter, count] of Object.entries(counts)) {
    if (count > maxCount) {
      maxCount = count;
      maxStarter = starter;
    }
  }

  const ratio = maxCount / starters.length;

  if (ratio >= 0.3) {
    return {
      score: 5,
      signals: [`Repetitive sentence starters: "${maxStarter}" starts ${maxCount}/${starters.length} sentences (${Math.round(ratio * 100)}%)`]
    };
  }
  if (ratio >= 0.2) {
    return {
      score: 3,
      signals: [`Moderate starter repetition: "${maxStarter}" starts ${maxCount}/${starters.length} sentences (${Math.round(ratio * 100)}%)`]
    };
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
    detectSuperficialIng(text),
    detectBurstiness(text),
    detectLexicalDiversity(text),
    detectSentenceStarterRepetition(text)
  ];

  const signals = [];
  const details = {};
  let rawTotal = 0;

  const names = [
    'sentenceLengthVariance', 'emDashDensity', 'paragraphUniformity',
    'hedgingDensity', 'perfectGrammar', 'superficialIng',
    'burstiness', 'lexicalDiversity', 'sentenceStarterRepetition'
  ];

  results.forEach((r, i) => {
    rawTotal += r.score;
    signals.push(...r.signals);
    details[names[i]] = r.score;
  });

  const score = Math.min(rawTotal, STYLOMETRY_MAX);
  return { score, signals, details };
}
