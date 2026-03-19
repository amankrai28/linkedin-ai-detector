/**
 * LinkedIn AI Detector — Layer 2: Structural Pattern Detection
 * Max score: 30 points
 *
 * Detects template-like post structures:
 *   Broetry format: 0–8 pts
 *   Hook-Story-Lesson-CTA arc: 0–10 pts
 *   Numbered wisdom lists: 0–7 pts
 *   Formulaic endings: 0–5 pts
 *   Negative parallelisms: 0–4 pts
 *   Rule of three: 0–4 pts
 *   False ranges: 0–3 pts
 */

const STRUCTURE_MAX = 30;

// ─── HELPERS ───

function splitSentences(text) {
  // Split on sentence-ending punctuation followed by space or end of string
  return text
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

function splitParagraphs(text) {
  return text
    .split(/\n\s*\n|\n/)
    .map(p => p.trim())
    .filter(p => p.length > 0);
}

// ─── DETECTORS ───

function detectBroetry(text) {
  const paragraphs = splitParagraphs(text);
  if (paragraphs.length < 3) return { score: 0, signals: [] };

  const singleSentenceParagraphs = paragraphs.filter(p => {
    const sentences = splitSentences(p);
    return sentences.length <= 1;
  });

  const ratio = singleSentenceParagraphs.length / paragraphs.length;

  if (ratio > 0.6) {
    return {
      score: 8,
      signals: [`Broetry format: ${Math.round(ratio * 100)}% single-sentence paragraphs`]
    };
  }
  if (ratio >= 0.4) {
    return {
      score: 4,
      signals: [`Mild broetry: ${Math.round(ratio * 100)}% single-sentence paragraphs`]
    };
  }
  return { score: 0, signals: [] };
}

function detectHookStoryLessonCTA(text) {
  const lower = text.toLowerCase();
  const sentences = splitSentences(text);
  if (sentences.length < 3) return { score: 0, signals: [] };

  let score = 0;
  const signals = [];

  // Hook: first sentence is question, exclamation, or strong claim
  const firstSentence = sentences[0];
  if (/[?!]/.test(firstSentence)) {
    score += 2;
    signals.push('Hook detected (opening question/exclamation)');
  }

  // Story: first-person narrative markers
  const storyMarkers = [
    'i was', 'i remember', 'last week', 'last month', 'last year',
    'years ago', 'a few years ago', 'when i was', 'one day', 'recently'
  ];
  if (storyMarkers.some(m => lower.includes(m))) {
    score += 2;
    signals.push('Story element detected (personal narrative)');
  }

  // Lesson: takeaway markers
  const lessonMarkers = [
    "here's what i learned", "here is what i learned", 'the lesson',
    'key takeaway', 'what this taught me', 'the biggest lesson',
    'what i realized', 'my takeaway'
  ];
  if (lessonMarkers.some(m => lower.includes(m))) {
    score += 3;
    signals.push('Lesson element detected (explicit takeaway)');
  }

  // CTA: last sentence is question or engagement prompt
  const lastSentence = sentences[sentences.length - 1].toLowerCase();
  const ctaMarkers = [
    'agree?', 'thoughts?', 'what do you think', 'share if',
    'repost if', 'tag someone', 'let me know', 'drop a comment',
    'comment below'
  ];
  if (/\?$/.test(lastSentence.trim()) || ctaMarkers.some(m => lastSentence.includes(m))) {
    score += 3;
    signals.push('CTA detected (engagement prompt at end)');
  }

  return { score: Math.min(score, 10), signals };
}

function detectNumberedWisdom(text) {
  const lower = text.toLowerCase();
  // Pattern: starts with "X things/lessons/tips/ways/reasons..." + numbered/bulleted items
  const headerPattern = /^\d+\s+(things|lessons|tips|ways|reasons|rules|steps|habits|truths|principles|strategies|mistakes)/m;
  const hasNumberedItems = /(?:^|\n)\s*[\d•·\-\*]\s*.+/gm;

  if (headerPattern.test(lower)) {
    const items = text.match(hasNumberedItems);
    if (items && items.length >= 3) {
      return {
        score: 7,
        signals: [`Numbered wisdom list: "${text.slice(0, 50).trim()}..."`]
      };
    }
  }
  return { score: 0, signals: [] };
}

function detectFormulaicEndings(text) {
  const lower = text.toLowerCase().trim();
  // Take the last ~20% of text
  const lastPortion = lower.slice(Math.floor(lower.length * 0.8));

  let maxScore = 0;
  const signals = [];

  const patterns = [
    { re: /\b(agree|thoughts)\?\s*$/i, pts: 3, label: 'Formulaic ending: "Agree?/Thoughts?"' },
    { re: /what do you think\?\s*$/i, pts: 3, label: 'Formulaic ending: "What do you think?"' },
    { re: /(repost|share) if (this resonated|you agree)/i, pts: 5, label: 'Formulaic ending: "Share/Repost if..."' },
    { re: /tag someone who needs this/i, pts: 5, label: 'Formulaic ending: "Tag someone..."' },
    { re: /follow me for more/i, pts: 4, label: 'Formulaic ending: "Follow me for more"' },
    { re: /follow for daily/i, pts: 4, label: 'Formulaic ending: "Follow for daily..."' }
  ];

  for (const { re, pts, label } of patterns) {
    if (re.test(lastPortion)) {
      if (pts > maxScore) maxScore = pts;
      signals.push(label);
    }
  }

  return { score: Math.min(maxScore, 5), signals };
}

function detectNegativeParallelisms(text) {
  const lower = text.toLowerCase();
  const patterns = [
    /not just\b/gi,
    /not only\b/gi,
    /it's not about\b.*it's about\b/gi,
    /it is not about\b.*it is about\b/gi
  ];

  let count = 0;
  const signals = [];
  for (const re of patterns) {
    const matches = lower.match(re);
    if (matches) {
      count += matches.length;
    }
  }

  if (count > 0) {
    const score = Math.min(count * 2, 4);
    signals.push(`${count} negative parallelism(s) detected`);
    return { score, signals };
  }
  return { score: 0, signals: [] };
}

function detectRuleOfThree(text) {
  // Count comma-separated lists of exactly 3 items
  // Pattern: "word, word, and word" or "word, word, word"
  const threeItemList = /\b\w+(?:\s+\w+)*,\s+\w+(?:\s+\w+)*,\s+(?:and\s+)?\w+(?:\s+\w+)*\b/gi;
  const matches = text.match(threeItemList);
  const count = matches ? matches.length : 0;

  if (count >= 2) {
    return { score: 4, signals: [`Rule of three: ${count} triple-item lists found`] };
  }
  if (count === 1) {
    return { score: 2, signals: ['Rule of three: 1 triple-item list found'] };
  }
  return { score: 0, signals: [] };
}

function detectFalseRanges(text) {
  const re = /from .+ to .+,\s*from .+ to/gi;
  if (re.test(text)) {
    return { score: 3, signals: ['False range construction detected ("from X to Y, from A to B")'] };
  }
  return { score: 0, signals: [] };
}

// ─── MAIN SCORER ───

function scoreStructure(text) {
  const results = [
    detectBroetry(text),
    detectHookStoryLessonCTA(text),
    detectNumberedWisdom(text),
    detectFormulaicEndings(text),
    detectNegativeParallelisms(text),
    detectRuleOfThree(text),
    detectFalseRanges(text)
  ];

  const signals = [];
  const details = {};
  let rawTotal = 0;

  const names = [
    'broetry', 'hookStoryLessonCTA', 'numberedWisdom',
    'formulaicEndings', 'negativeParallelisms', 'ruleOfThree', 'falseRanges'
  ];

  results.forEach((r, i) => {
    rawTotal += r.score;
    signals.push(...r.signals);
    details[names[i]] = r.score;
  });

  const score = Math.min(rawTotal, STRUCTURE_MAX);
  return { score, signals, details };
}
