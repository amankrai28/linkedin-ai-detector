/**
 * LinkedIn AI Detector — Layer 4: LinkedIn-Specific Signals
 * Max score: 15 points
 *
 * Platform-specific gaming patterns:
 *   Hashtag stuffing: 0–3 pts
 *   Emoji as structure: 0–4 pts
 *   Personal brand formula: 0–5 pts
 *   Scroll manipulation: 0–3 pts
 */

const LINKEDIN_MAX = 15;

// ─── DETECTORS ───

function detectHashtagStuffing(text) {
  // Count hashtags in the last 20% of the post
  const lastPortion = text.slice(Math.floor(text.length * 0.8));
  const hashtags = lastPortion.match(/#\w+/g) || [];
  const count = hashtags.length;

  if (count > 5) {
    return { score: 3, signals: [`${count} hashtags clustered at end of post`] };
  }
  if (count >= 3) {
    return { score: 1, signals: [`${count} hashtags at end of post`] };
  }
  return { score: 0, signals: [] };
}

function detectEmojiAsStructure(text) {
  // Detect emoji at start of lines (used as bullet points)
  // Unicode emoji ranges (simplified — covers most common emoji)
  const emojiLineStart = /^[\u{1F300}-\u{1F9FF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}✅❌⚡️🔥💡🚀⭐️🎯📌🔑💪👉✨🌟💰📈🏆]/mu;

  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  let emojiLineCount = 0;

  for (const line of lines) {
    if (emojiLineStart.test(line)) {
      emojiLineCount++;
    }
  }

  if (emojiLineCount >= 3) {
    return { score: 4, signals: [`${emojiLineCount} lines start with emoji (used as bullet points)`] };
  }
  if (emojiLineCount >= 1) {
    return { score: 2, signals: [`${emojiLineCount} line(s) start with emoji as structure`] };
  }
  return { score: 0, signals: [] };
}

function detectPersonalBrandFormula(text) {
  const lower = text.toLowerCase();
  let score = 0;
  const signals = [];

  // Opening with rejection/failure vulnerability
  const openingTriggers = [
    'i was rejected', 'i was fired', 'i was told no', 'i failed',
    'i got rejected', 'i lost my job', 'i was laid off', 'i dropped out'
  ];
  // Check first ~25% of text for opening triggers
  const opening = lower.slice(0, Math.floor(lower.length * 0.25));
  if (openingTriggers.some(t => opening.includes(t))) {
    score += 2;
    signals.push('Personal brand: opens with vulnerability/rejection');

    // Reversal/success story
    const reversalMarkers = [
      'but then', 'fast forward', 'today i', 'now i',
      "that's when", 'everything changed'
    ];
    if (reversalMarkers.some(m => lower.includes(m))) {
      score += 2;
      signals.push('Personal brand: contains reversal/success arc');
    }
  }

  // Lesson marker
  const lessonMarkers = [
    "here's what i learned", "here is what i learned",
    'the lesson', 'what this taught me'
  ];
  if (lessonMarkers.some(m => lower.includes(m))) {
    score += 1;
    signals.push('Personal brand: explicit lesson statement');
  }

  return { score: Math.min(score, 5), signals };
}

function detectScrollManipulation(text) {
  const lines = text.split('\n');
  const contentLines = lines.filter(l => l.trim().length > 0);
  const blankLines = lines.filter(l => l.trim().length === 0);

  // Also count single-word paragraphs
  const singleWordLines = contentLines.filter(l => l.trim().split(/\s+/).length === 1);

  if (contentLines.length === 0) return { score: 0, signals: [] };

  const blankRatio = blankLines.length / contentLines.length;
  const singleWordRatio = singleWordLines.length / contentLines.length;

  if (blankRatio > 0.5 || singleWordRatio > 0.3) {
    return {
      score: 3,
      signals: [`Scroll manipulation: ${blankLines.length} blank lines, ${singleWordLines.length} single-word lines`]
    };
  }
  return { score: 0, signals: [] };
}

// ─── MAIN SCORER ───

function scoreLinkedIn(text) {
  const results = [
    detectHashtagStuffing(text),
    detectEmojiAsStructure(text),
    detectPersonalBrandFormula(text),
    detectScrollManipulation(text)
  ];

  const signals = [];
  const details = {};
  let rawTotal = 0;

  const names = ['hashtagStuffing', 'emojiAsStructure', 'personalBrandFormula', 'scrollManipulation'];

  results.forEach((r, i) => {
    rawTotal += r.score;
    signals.push(...r.signals);
    details[names[i]] = r.score;
  });

  const score = Math.min(rawTotal, LINKEDIN_MAX);
  return { score, signals, details };
}
