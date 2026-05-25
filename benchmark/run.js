#!/usr/bin/env node
/**
 * Benchmark harness — runs the heuristic scoring engine over the labeled set
 * and emits a metrics report to ./results/<timestamp>.md
 *
 * Heuristic-only for now (no ML). The ML side of the engine runs in Chrome's
 * offscreen document via Transformers.js; running that in Node is doable but
 * a larger lift — separate task.
 *
 * Usage:
 *   node run.js [--threshold N] [--set path]
 *
 *   --threshold N    Primary binary cutoff for AI vs non-AI (default 50)
 *   --set path       Path to labeled set (default ./labeled-set.json)
 *
 * The report includes:
 *   - Headline metrics at primary threshold (precision, recall, F1, accuracy)
 *   - Confusion matrix
 *   - Per-source breakdown (which profile / type underperforms)
 *   - Per-bucket accuracy (green ≤35 / amber 36-65 / red ≥66)
 *   - Calibration table (does score X% really mean ~X% AI probability?)
 *   - Threshold sweep (P/R/F1 at 30, 40, 50, 60, 70)
 *   - Score distribution stats per label
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ─── ARGS ───
const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
}
const PRIMARY_THRESHOLD = Number(arg('--threshold', 50));
const SET_PATH = arg('--set', path.join(__dirname, 'labeled-set.json'));

// ─── LOAD SCORING ENGINE ───
const SCORING_DIR = path.join(__dirname, '..', 'scoring');
const FILES = ['vocabulary.js', 'structure.js', 'stylometry.js', 'linkedin.js', 'ml-preprocess.js', 'engine.js'];
const combined = FILES.map(f => fs.readFileSync(path.join(SCORING_DIR, f), 'utf8')).join('\n;\n');
const EXPOSE = `;__engine = { scorePostSync, scorePostHeuristic };`;
const ctx = { console, __engine: null };
vm.createContext(ctx);
vm.runInContext(combined + EXPOSE, ctx, { filename: 'scoring-bundle.js' });
const { scorePostSync } = ctx.__engine;
if (typeof scorePostSync !== 'function') {
  console.error('Failed to load scoring engine');
  process.exit(1);
}

// ─── LOAD SET ───
const set = JSON.parse(fs.readFileSync(SET_PATH, 'utf-8'));
const posts = set.posts;
console.log(`Loaded ${posts.length} posts from ${SET_PATH}`);

// ─── SCORE ALL ───
const scored = posts.map(p => {
  const result = scorePostSync(p.text.normalize('NFKC'));
  return {
    id: p.id,
    label: p.label,
    ai_involvement: p.ai_involvement,
    confidence: p.confidence,
    source: p.source,
    wordCount: p.wordCount || (p.text.split(/\s+/).filter(Boolean).length),
    score: result.score,
    partial: !!result.partial,
    layers: {
      vocabulary: result.layers.vocabulary.score,
      structure: result.layers.structure.score,
      stylometry: result.layers.stylometry.score,
      linkedin: result.layers.linkedin.score
    },
    topSignals: (result.topSignals || []).slice(0, 4)
  };
});

// ─── METRICS HELPERS ───

// Treat label === 'ai' as positive class. 'hybrid' counts as positive in
// "anything AI-touched" mode; we report both interpretations separately.
function isPositive(p, mode) {
  if (mode === 'strict') return p.label === 'ai';
  if (mode === 'inclusive') return p.label === 'ai' || p.label === 'hybrid';
  return p.label === 'ai';
}

function confusion(rows, threshold, mode) {
  let tp = 0, fp = 0, tn = 0, fn = 0;
  for (const r of rows) {
    const actual = isPositive(r, mode);
    const predicted = r.score >= threshold;
    if (actual && predicted) tp++;
    else if (!actual && predicted) fp++;
    else if (!actual && !predicted) tn++;
    else fn++;
  }
  const precision = tp / Math.max(tp + fp, 1);
  const recall = tp / Math.max(tp + fn, 1);
  const f1 = 2 * precision * recall / Math.max(precision + recall, 1e-9);
  const accuracy = (tp + tn) / Math.max(rows.length, 1);
  return { tp, fp, tn, fn, precision, recall, f1, accuracy, total: rows.length };
}

function pct(x) { return (x * 100).toFixed(1) + '%'; }
function fix(x, n = 1) { return Number(x).toFixed(n); }

function bucket(score) {
  if (score <= 35) return 'green';
  if (score <= 65) return 'amber';
  return 'red';
}

function bucketAccuracy(rows) {
  const expected = { ai: 'red', human: 'green', hybrid: 'amber' };
  let correct = 0;
  const breakdown = { ai: { correct: 0, total: 0 }, human: { correct: 0, total: 0 }, hybrid: { correct: 0, total: 0 } };
  for (const r of rows) {
    const exp = expected[r.label];
    const got = bucket(r.score);
    breakdown[r.label].total++;
    if (exp === got) { correct++; breakdown[r.label].correct++; }
  }
  return { overall: correct / Math.max(rows.length, 1), breakdown };
}

function calibration(rows, bins = 10) {
  const out = [];
  const step = 100 / bins;
  for (let i = 0; i < bins; i++) {
    const lo = i * step, hi = (i + 1) * step;
    const inBin = rows.filter(r => r.score >= lo && (i === bins - 1 ? r.score <= hi : r.score < hi));
    if (inBin.length === 0) { out.push({ range: `${lo}–${hi}`, count: 0, aiRate: null, avgScore: null }); continue; }
    const aiRate = inBin.filter(r => isPositive(r, 'inclusive')).length / inBin.length;
    const avgScore = inBin.reduce((s, r) => s + r.score, 0) / inBin.length;
    out.push({ range: `${lo}–${hi}`, count: inBin.length, aiRate, avgScore });
  }
  return out;
}

function thresholdSweep(rows, mode) {
  return [30, 40, 50, 60, 70].map(t => ({ threshold: t, ...confusion(rows, t, mode) }));
}

function distributionStats(rows) {
  const byLabel = {};
  for (const r of rows) {
    if (!byLabel[r.label]) byLabel[r.label] = [];
    byLabel[r.label].push(r.score);
  }
  return Object.fromEntries(Object.entries(byLabel).map(([label, scores]) => {
    scores.sort((a, b) => a - b);
    const mean = scores.reduce((s, v) => s + v, 0) / scores.length;
    const median = scores[Math.floor(scores.length / 2)];
    const min = scores[0], max = scores[scores.length - 1];
    const variance = scores.reduce((s, v) => s + (v - mean) ** 2, 0) / scores.length;
    return [label, { count: scores.length, mean, median, min, max, stddev: Math.sqrt(variance) }];
  }));
}

function perSourceBreakdown(rows) {
  const by = {};
  for (const r of rows) {
    const key = r.source.profileName || r.source.type;
    if (!by[key]) by[key] = [];
    by[key].push(r);
  }
  return Object.fromEntries(Object.entries(by).map(([key, group]) => {
    const scores = group.map(r => r.score);
    const mean = scores.reduce((s, v) => s + v, 0) / scores.length;
    const labels = [...new Set(group.map(r => r.label))];
    return [key, { count: group.length, meanScore: mean, labels, lowest: Math.min(...scores), highest: Math.max(...scores) }];
  }));
}

// ─── BUILD REPORT ───
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const RESULTS_DIR = path.join(__dirname, 'results');
fs.mkdirSync(RESULTS_DIR, { recursive: true });
const reportPath = path.join(RESULTS_DIR, `${stamp}.md`);

const mainConfStrict = confusion(scored, PRIMARY_THRESHOLD, 'strict');
const mainConfInclusive = confusion(scored, PRIMARY_THRESHOLD, 'inclusive');
const bucketsResult = bucketAccuracy(scored);
const calStrict = calibration(scored);
const sweepStrict = thresholdSweep(scored, 'strict');
const sweepInclusive = thresholdSweep(scored, 'inclusive');
const distStats = distributionStats(scored);
const sourceStats = perSourceBreakdown(scored);

const failedRed = scored.filter(r => r.label === 'ai' && r.score < PRIMARY_THRESHOLD);
const falseRed = scored.filter(r => r.label === 'human' && r.score >= PRIMARY_THRESHOLD);

const lines = [];
lines.push(`# Benchmark Report — ${stamp}`);
lines.push('');
lines.push(`- **Set**: \`${path.relative(process.cwd(), SET_PATH)}\``);
lines.push(`- **Posts scored**: ${scored.length}`);
lines.push(`- **Engine**: heuristic-only (no ML)`);
lines.push(`- **Primary threshold**: ${PRIMARY_THRESHOLD}`);
lines.push('');

lines.push('## Headline (label === "ai" is positive)');
lines.push('');
lines.push(`| Metric    | Value         |`);
lines.push(`|-----------|---------------|`);
lines.push(`| Precision | ${pct(mainConfStrict.precision)} |`);
lines.push(`| Recall    | ${pct(mainConfStrict.recall)} |`);
lines.push(`| F1        | ${fix(mainConfStrict.f1, 3)} |`);
lines.push(`| Accuracy  | ${pct(mainConfStrict.accuracy)} |`);
lines.push('');
lines.push('### Confusion (strict — "ai" is positive)');
lines.push(`| .            | Predicted AI | Predicted not-AI |`);
lines.push(`|--------------|--------------|------------------|`);
lines.push(`| Actual AI    | TP=${mainConfStrict.tp}      | FN=${mainConfStrict.fn}              |`);
lines.push(`| Actual not-AI| FP=${mainConfStrict.fp}      | TN=${mainConfStrict.tn}              |`);
lines.push('');

lines.push('### Confusion (inclusive — "ai" or "hybrid" is positive)');
lines.push(`| .                | Predicted AI | Predicted not-AI |`);
lines.push(`|------------------|--------------|------------------|`);
lines.push(`| Actual AI/hybrid | TP=${mainConfInclusive.tp}      | FN=${mainConfInclusive.fn}              |`);
lines.push(`| Actual human     | FP=${mainConfInclusive.fp}      | TN=${mainConfInclusive.tn}              |`);
lines.push(`| Precision        | ${pct(mainConfInclusive.precision)} | Recall: ${pct(mainConfInclusive.recall)} | F1: ${fix(mainConfInclusive.f1, 3)} |`);
lines.push('');

lines.push('## Bucket accuracy (green/amber/red)');
lines.push('');
lines.push(`Expected mapping: human → green, hybrid → amber, ai → red.`);
lines.push('');
lines.push(`| Label  | Correct / Total | Hit rate |`);
lines.push(`|--------|------------------|----------|`);
for (const [k, v] of Object.entries(bucketsResult.breakdown)) {
  if (v.total > 0) lines.push(`| ${k}   | ${v.correct} / ${v.total} | ${pct(v.correct / v.total)} |`);
}
lines.push(`| **Overall** | — | **${pct(bucketsResult.overall)}** |`);
lines.push('');

lines.push('## Threshold sweep');
lines.push('');
lines.push(`### Strict (label === "ai")`);
lines.push(`| Threshold | TP | FP | TN | FN | Precision | Recall | F1   |`);
lines.push(`|-----------|----|----|----|----|-----------|--------|------|`);
for (const s of sweepStrict) {
  lines.push(`| ${s.threshold} | ${s.tp} | ${s.fp} | ${s.tn} | ${s.fn} | ${pct(s.precision)} | ${pct(s.recall)} | ${fix(s.f1, 3)} |`);
}
lines.push('');
lines.push(`### Inclusive ("ai" or "hybrid")`);
lines.push(`| Threshold | TP | FP | TN | FN | Precision | Recall | F1   |`);
lines.push(`|-----------|----|----|----|----|-----------|--------|------|`);
for (const s of sweepInclusive) {
  lines.push(`| ${s.threshold} | ${s.tp} | ${s.fp} | ${s.tn} | ${s.fn} | ${pct(s.precision)} | ${pct(s.recall)} | ${fix(s.f1, 3)} |`);
}
lines.push('');

lines.push('## Calibration (inclusive)');
lines.push('');
lines.push(`Each bin shows count of posts whose score landed in the range, and what fraction of those were actually AI or hybrid.`);
lines.push('');
lines.push(`| Score range | Count | Actual AI/hybrid rate | Mean score |`);
lines.push(`|-------------|-------|------------------------|------------|`);
for (const c of calStrict) {
  if (c.count === 0) { lines.push(`| ${c.range} | 0 | — | — |`); continue; }
  lines.push(`| ${c.range} | ${c.count} | ${pct(c.aiRate)} | ${fix(c.avgScore, 1)} |`);
}
lines.push('');

lines.push('## Score distribution by label');
lines.push('');
lines.push(`| Label  | n  | mean | median | min | max | stddev |`);
lines.push(`|--------|----|------|--------|-----|-----|--------|`);
for (const [label, s] of Object.entries(distStats)) {
  lines.push(`| ${label} | ${s.count} | ${fix(s.mean, 1)} | ${s.median} | ${s.min} | ${s.max} | ${fix(s.stddev, 1)} |`);
}
lines.push('');

lines.push('## Per-source');
lines.push('');
lines.push(`| Source | n  | Labels | Mean score | Min | Max |`);
lines.push(`|--------|----|--------|-----------|-----|-----|`);
for (const [src, s] of Object.entries(sourceStats)) {
  lines.push(`| ${src} | ${s.count} | ${s.labels.join(', ')} | ${fix(s.meanScore, 1)} | ${s.lowest} | ${s.highest} |`);
}
lines.push('');

if (failedRed.length > 0) {
  lines.push(`## Misses: AI posts that scored below threshold (${failedRed.length})`);
  lines.push('');
  for (const r of failedRed.slice(0, 10)) {
    lines.push(`- **${r.score}/100** (V:${r.layers.vocabulary} S:${r.layers.structure} St:${r.layers.stylometry} L:${r.layers.linkedin}) — ${r.source.profileName} · ${r.wordCount}w`);
    if (r.topSignals.length) lines.push(`  - signals: ${r.topSignals.map(s => typeof s === 'string' ? s : (s.signal || s.label || JSON.stringify(s))).join('; ')}`);
  }
  lines.push('');
}

if (falseRed.length > 0) {
  lines.push(`## False positives: human posts predicted as AI (${falseRed.length})`);
  lines.push('');
  for (const r of falseRed.slice(0, 10)) {
    lines.push(`- **${r.score}/100** (V:${r.layers.vocabulary} S:${r.layers.structure} St:${r.layers.stylometry} L:${r.layers.linkedin}) — ${r.source.type}/${r.source.profileName||''} · ${r.wordCount}w`);
  }
  lines.push('');
}

fs.writeFileSync(reportPath, lines.join('\n') + '\n');
console.log(`\nReport written: ${path.relative(process.cwd(), reportPath)}`);

// Also dump raw scored rows for downstream tooling
const rawPath = path.join(RESULTS_DIR, `${stamp}.json`);
fs.writeFileSync(rawPath, JSON.stringify(scored, null, 2));
console.log(`Raw scores:    ${path.relative(process.cwd(), rawPath)}`);
