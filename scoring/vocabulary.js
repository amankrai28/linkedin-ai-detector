/**
 * LinkedIn AI Detector — Layer 1: Vocabulary Fingerprinting
 * Max score: 30 points
 *
 * Detects AI-overrepresented words and phrases across 6 sub-categories:
 *   Tier 1 (dead giveaways): 3 pts each, cap 15
 *   Tier 2 (moderate signals): 1.5 pts each, cap 12
 *   Tier 3 (contextual): 0.5 pts each, 2x if 3+ co-occur, cap 8 (gated: only scores if 3+ T1/T2 present)
 *   Copula avoidance: 2 pts each, cap 10
 *   Communication artifacts: 4 pts each, cap 12
 *   Co-occurrence density: bonus for multiple AI words in same post, cap 10
 */

const VOCAB_MAX = 30;

// ─── PATTERN DEFINITIONS ───

const TIER1_WORDS = [
  'delve', 'tapestry', 'testament', 'landscape', 'pivotal',
  'unwavering', 'paramount', 'foster', 'fostering', 'leverage',
  'underscores', 'showcasing', 'encompassing', 'cultivating',
  'intricate', 'intricacies', 'interplay', 'indelible mark', 'enduring'
];
const TIER1_PTS = 3;
const TIER1_CAP = 15;

const TIER2_PHRASES = [
  "it's worth noting", "it is worth noting", "at the end of the day",
  "here's the kicker", "here is the kicker", "let me be clear",
  "in today's rapidly evolving", "at its core", "the reality is",
  "here's the thing", "here is the thing", "let that sink in",
  "game-changer", "game changer", "deep dive", "unpack",
  "double down", "move the needle", "lean into", "circle back",
  "it goes without saying", "needless to say", "when it comes to",
  "in a world where", "it is important to note", "this is a reminder that"
];
const TIER2_PTS = 1.5;
const TIER2_CAP = 12;

const TIER3_WORDS = [
  'additionally', 'align with', 'crucial', 'enhance', 'garner',
  'highlight', 'key', 'robust', 'streamline', 'holistic',
  'navigate', 'innovative', 'comprehensive', 'leverage', 'optimize',
  'synergy', 'ecosystem', 'scalable', 'actionable', 'impactful',
  'empower', 'elevate', 'resonate', 'curate', 'craft'
];
const TIER3_PTS = 0.5;
const TIER3_MULTIPLIER = 2;
const TIER3_CLUSTER_THRESHOLD = 3;
const TIER3_CAP = 8;

const COPULA_PHRASES = [
  'serves as', 'stands as', 'marks a', 'represents a',
  'boasts a', 'features a', 'offers a'
];
const COPULA_PTS = 2;
const COPULA_CAP = 10;

const COMM_ARTIFACTS = [
  'I hope this helps', 'Great question!', 'Certainly!', 'Of course!',
  "You're absolutely right", 'Would you like me to', 'Let me know if',
  'Here is a', 'As of my last', 'based on available information'
];
const COMM_PTS = 4;
const COMM_CAP = 12;

// ─── HELPERS ───

function countMatches(text, patterns, wordBoundary) {
  const lower = text.toLowerCase();
  const matched = [];
  for (const pattern of patterns) {
    const p = pattern.toLowerCase();
    if (wordBoundary) {
      // Use word boundary regex for single words to avoid partial matches
      // e.g. "key" shouldn't match "keyboard"
      const re = new RegExp('\\b' + p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi');
      if (re.test(lower)) {
        matched.push(pattern);
      }
    } else {
      if (lower.includes(p)) {
        matched.push(pattern);
      }
    }
  }
  return matched;
}

// ─── MAIN SCORER ───

function scoreVocabulary(text) {
  const signals = [];
  const details = {
    tier1: { matches: [], raw: 0 },
    tier2: { matches: [], raw: 0 },
    tier3: { matches: [], raw: 0, clusterApplied: false },
    copula: { matches: [], raw: 0 },
    artifacts: { matches: [], raw: 0 },
    coOccurrence: { count: 0, raw: 0 }
  };

  // Tier 1: Dead giveaways
  // "landscape" and "tapestry" only count in abstract/figurative use,
  // but reliably detecting figurative vs literal is hard — count all occurrences
  // and accept the rare false positive.
  const t1 = countMatches(text, TIER1_WORDS, true);
  details.tier1.matches = t1;
  details.tier1.raw = Math.min(t1.length * TIER1_PTS, TIER1_CAP);
  t1.forEach(w => signals.push(`"${w}" (vocabulary tier 1)`));

  // Tier 2: Moderate signals
  const t2 = countMatches(text, TIER2_PHRASES, false);
  details.tier2.matches = t2;
  details.tier2.raw = Math.min(t2.length * TIER2_PTS, TIER2_CAP);
  t2.forEach(p => signals.push(`"${p}" (vocabulary tier 2)`));

  // Tier 3: Contextual signals — only score if 3+ T1/T2 words already present
  // These words are too common in normal business writing to count on their own.
  const t3 = countMatches(text, TIER3_WORDS, true);
  details.tier3.matches = t3;
  const t1t2Count = t1.length + t2.length;
  if (t1t2Count >= 3) {
    let t3raw = t3.length * TIER3_PTS;
    if (t3.length >= TIER3_CLUSTER_THRESHOLD) {
      t3raw *= TIER3_MULTIPLIER;
      details.tier3.clusterApplied = true;
    }
    details.tier3.raw = Math.min(t3raw, TIER3_CAP);
    if (t3.length > 0) {
      signals.push(`${t3.length} contextual buzzwords (gated by ${t1t2Count} T1+T2): ${t3.slice(0, 5).map(w => `"${w}"`).join(', ')}${t3.length > 5 ? '...' : ''}`);
    }
  } else {
    details.tier3.raw = 0;
    if (t3.length > 0) {
      signals.push(`${t3.length} contextual buzzwords ignored (only ${t1t2Count} T1+T2 words, need 3+)`);
    }
  }

  // Copula avoidance
  const cop = countMatches(text, COPULA_PHRASES, false);
  details.copula.matches = cop;
  details.copula.raw = Math.min(cop.length * COPULA_PTS, COPULA_CAP);
  cop.forEach(p => signals.push(`"${p}" (copula avoidance)`));

  // Communication artifacts
  const art = countMatches(text, COMM_ARTIFACTS, false);
  details.artifacts.matches = art;
  details.artifacts.raw = Math.min(art.length * COMM_PTS, COMM_CAP);
  art.forEach(p => signals.push(`"${p}" (communication artifact)`));

  // Co-occurrence density: count distinct Tier 1 + Tier 2 words in same post
  const coOccurrenceCount = t1.length + t2.length;
  details.coOccurrence.count = coOccurrenceCount;
  let coOccurrenceBonus = 0;
  if (coOccurrenceCount >= 5) {
    coOccurrenceBonus = 10;
  } else if (coOccurrenceCount >= 4) {
    coOccurrenceBonus = 6;
  } else if (coOccurrenceCount >= 3) {
    coOccurrenceBonus = 4;
  }
  details.coOccurrence.raw = coOccurrenceBonus;
  if (coOccurrenceBonus > 0) {
    signals.push(`AI vocabulary co-occurrence: ${coOccurrenceCount} distinct T1+T2 words (+${coOccurrenceBonus})`);
  }

  // Sum all sub-scores, cap at layer max
  const rawTotal = details.tier1.raw + details.tier2.raw + details.tier3.raw
    + details.copula.raw + details.artifacts.raw + details.coOccurrence.raw;
  const score = Math.min(rawTotal, VOCAB_MAX);

  return { score, signals, details };
}
