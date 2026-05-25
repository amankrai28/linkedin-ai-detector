#!/usr/bin/env node
/**
 * Benchmark harness — runs the scoring engine over the labeled set
 * and emits a metrics report to ./results/<timestamp>.md
 *
 * Heuristic always runs. ML runs only with --ml (slower; loads ~100MB model
 * on first run, cached afterwards). When ML is enabled we report three
 * variants of every metric: heuristic-only, ML-only, and the Noisy-OR
 * blend that the extension uses in production.
 *
 * Usage:
 *   node run.js [--threshold N] [--set path] [--ml]
 *
 *   --threshold N    Primary binary cutoff for AI vs non-AI (default 50)
 *   --set path       Path to labeled set (default ./labeled-set.json)
 *   --ml             Enable Transformers.js ML scoring (Fakespot RoBERTa)
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
const flag = (name) => args.includes(name);
const PRIMARY_THRESHOLD = Number(arg('--threshold', 50));
const SET_PATH = arg('--set', path.join(__dirname, 'labeled-set.json'));
const ENABLE_ML = flag('--ml');
const ML_MODEL = arg('--model', 'amankrai28/fakespot-roberta-ai-detector-onnx');
const ML_DTYPE = arg('--dtype', 'q8');

// ─── LOAD HEURISTIC ENGINE ───
const SCORING_DIR = path.join(__dirname, '..', 'scoring');
const FILES = ['vocabulary.js', 'structure.js', 'stylometry.js', 'linkedin.js', 'ml-preprocess.js', 'engine.js'];
const combined = FILES.map(f => fs.readFileSync(path.join(SCORING_DIR, f), 'utf8')).join('\n;\n');
const EXPOSE = `;__engine = { scorePostSync, scorePostHeuristic, preprocessForML };`;
const ctx = { console, __engine: null };
vm.createContext(ctx);
vm.runInContext(combined + EXPOSE, ctx, { filename: 'scoring-bundle.js' });
const { scorePostSync, preprocessForML } = ctx.__engine;
if (typeof scorePostSync !== 'function') {
  console.error('Failed to load scoring engine');
  process.exit(1);
}

// ─── METRICS HELPERS ───

function isPositive(p, mode) {
  if (mode === 'inclusive') return p.label === 'ai' || p.label === 'hybrid';
  return p.label === 'ai'; // strict
}

function confusion(rows, threshold, mode, scoreField) {
  let tp = 0, fp = 0, tn = 0, fn = 0;
  for (const r of rows) {
    const s = r[scoreField];
    if (s == null) continue;
    const actual = isPositive(r, mode);
    const predicted = s >= threshold;
    if (actual && predicted) tp++;
    else if (!actual && predicted) fp++;
    else if (!actual && !predicted) tn++;
    else fn++;
  }
  const precision = tp / Math.max(tp + fp, 1);
  const recall = tp / Math.max(tp + fn, 1);
  const f1 = 2 * precision * recall / Math.max(precision + recall, 1e-9);
  const accuracy = (tp + tn) / Math.max(rows.length, 1);
  return { tp, fp, tn, fn, precision, recall, f1, accuracy };
}

const pct = (x) => (x * 100).toFixed(1) + '%';
const fix = (x, n = 1) => Number(x).toFixed(n);

function bucket(score) {
  if (score == null) return 'unknown';
  if (score <= 35) return 'green';
  if (score <= 65) return 'amber';
  return 'red';
}

function bucketAccuracy(rows, scoreField) {
  const expected = { ai: 'red', human: 'green', hybrid: 'amber' };
  let correct = 0, total = 0;
  const breakdown = { ai: { correct: 0, total: 0 }, human: { correct: 0, total: 0 }, hybrid: { correct: 0, total: 0 } };
  for (const r of rows) {
    if (r[scoreField] == null) continue;
    const exp = expected[r.label];
    const got = bucket(r[scoreField]);
    breakdown[r.label].total++;
    total++;
    if (exp === got) { correct++; breakdown[r.label].correct++; }
  }
  return { overall: correct / Math.max(total, 1), breakdown };
}

function calibration(rows, scoreField, bins = 10) {
  const out = [];
  const step = 100 / bins;
  for (let i = 0; i < bins; i++) {
    const lo = i * step, hi = (i + 1) * step;
    const inBin = rows.filter(r => r[scoreField] != null && r[scoreField] >= lo && (i === bins - 1 ? r[scoreField] <= hi : r[scoreField] < hi));
    if (inBin.length === 0) { out.push({ range: `${lo}–${hi}`, count: 0, aiRate: null, avgScore: null }); continue; }
    const aiRate = inBin.filter(r => isPositive(r, 'inclusive')).length / inBin.length;
    const avgScore = inBin.reduce((s, r) => s + r[scoreField], 0) / inBin.length;
    out.push({ range: `${lo}–${hi}`, count: inBin.length, aiRate, avgScore });
  }
  return out;
}

function thresholdSweep(rows, mode, scoreField) {
  return [30, 40, 50, 60, 70].map(t => ({ threshold: t, ...confusion(rows, t, mode, scoreField) }));
}

function distributionStats(rows, scoreField) {
  const byLabel = {};
  for (const r of rows) {
    if (r[scoreField] == null) continue;
    if (!byLabel[r.label]) byLabel[r.label] = [];
    byLabel[r.label].push(r[scoreField]);
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

// ─── REPORT ───

function variantTable(label, rows, scoreField) {
  const lines = [];
  const main = confusion(rows, PRIMARY_THRESHOLD, 'strict', scoreField);
  const inc = confusion(rows, PRIMARY_THRESHOLD, 'inclusive', scoreField);
  const buckets = bucketAccuracy(rows, scoreField);
  const sweepStrict = thresholdSweep(rows, 'strict', scoreField);
  const sweepInc = thresholdSweep(rows, 'inclusive', scoreField);
  const cal = calibration(rows, scoreField);
  const dist = distributionStats(rows, scoreField);

  lines.push(`### ${label} — strict ("ai" only is positive)`);
  lines.push(`| Precision | Recall | F1 | Accuracy | TP | FP | TN | FN |`);
  lines.push(`|---|---|---|---|---|---|---|---|`);
  lines.push(`| ${pct(main.precision)} | ${pct(main.recall)} | ${fix(main.f1, 3)} | ${pct(main.accuracy)} | ${main.tp} | ${main.fp} | ${main.tn} | ${main.fn} |`);
  lines.push('');
  lines.push(`### ${label} — inclusive ("ai" + "hybrid")`);
  lines.push(`| Precision | Recall | F1 | Accuracy | TP | FP | TN | FN |`);
  lines.push(`|---|---|---|---|---|---|---|---|`);
  lines.push(`| ${pct(inc.precision)} | ${pct(inc.recall)} | ${fix(inc.f1, 3)} | ${pct(inc.accuracy)} | ${inc.tp} | ${inc.fp} | ${inc.tn} | ${inc.fn} |`);
  lines.push('');
  lines.push(`### ${label} — bucket accuracy`);
  lines.push(`| Label | Correct / Total | Hit rate |`);
  lines.push(`|---|---|---|`);
  for (const [k, v] of Object.entries(buckets.breakdown)) {
    if (v.total > 0) lines.push(`| ${k} | ${v.correct} / ${v.total} | ${pct(v.correct / v.total)} |`);
  }
  lines.push(`| **Overall** | — | **${pct(buckets.overall)}** |`);
  lines.push('');
  lines.push(`### ${label} — threshold sweep (strict)`);
  lines.push(`| Threshold | TP | FP | TN | FN | Precision | Recall | F1 |`);
  lines.push(`|---|---|---|---|---|---|---|---|`);
  for (const s of sweepStrict) {
    lines.push(`| ${s.threshold} | ${s.tp} | ${s.fp} | ${s.tn} | ${s.fn} | ${pct(s.precision)} | ${pct(s.recall)} | ${fix(s.f1, 3)} |`);
  }
  lines.push('');
  lines.push(`### ${label} — calibration (inclusive)`);
  lines.push(`| Score range | Count | Actual AI/hybrid rate | Mean score |`);
  lines.push(`|---|---|---|---|`);
  for (const c of cal) {
    if (c.count === 0) { lines.push(`| ${c.range} | 0 | — | — |`); continue; }
    lines.push(`| ${c.range} | ${c.count} | ${pct(c.aiRate)} | ${fix(c.avgScore, 1)} |`);
  }
  lines.push('');
  lines.push(`### ${label} — distribution by label`);
  lines.push(`| Label | n | mean | median | min | max | stddev |`);
  lines.push(`|---|---|---|---|---|---|---|`);
  for (const [k, s] of Object.entries(dist)) {
    lines.push(`| ${k} | ${s.count} | ${fix(s.mean, 1)} | ${s.median} | ${s.min} | ${s.max} | ${fix(s.stddev, 1)} |`);
  }
  lines.push('');
  return lines;
}

// ─── MAIN ───

(async () => {
  const set = JSON.parse(fs.readFileSync(SET_PATH, 'utf-8'));
  const posts = set.posts;
  console.log(`Loaded ${posts.length} posts from ${SET_PATH}`);

  // Score heuristic for all posts
  const scored = posts.map(p => {
    const result = scorePostSync(p.text.normalize('NFKC'));
    return {
      id: p.id,
      label: p.label,
      ai_involvement: p.ai_involvement,
      confidence: p.confidence,
      source: p.source,
      wordCount: p.wordCount || (p.text.split(/\s+/).filter(Boolean).length),
      heuristicScore: result.score,
      partial: !!result.partial,
      layers: {
        vocabulary: result.layers.vocabulary.score,
        structure: result.layers.structure.score,
        stylometry: result.layers.stylometry.score,
        linkedin: result.layers.linkedin.score
      },
      topSignals: (result.topSignals || []).slice(0, 4),
      mlScore: null,
      mlLabel: null,
      mlConfidence: null,
      blendedScore: null,
      text: p.text
    };
  });

  // ML pass — optional
  if (ENABLE_ML) {
    console.log(`Loading Transformers.js + model ${ML_MODEL} (dtype=${ML_DTYPE})...`);
    const { pipeline } = await import('@huggingface/transformers');
    const classifier = await pipeline(
      'text-classification',
      ML_MODEL,
      { dtype: ML_DTYPE }
    );
    console.log('Model loaded. Scoring posts...');

    let i = 0;
    for (const row of scored) {
      i++;
      try {
        const cleaned = preprocessForML(row.text);
        const results = await classifier(cleaned, { topk: 2 });
        const top = results[0];
        // Different models use different label conventions; treat any of these
        // as "AI" labels: AI, GPT, LABEL_1, Fake, Machine, Generated.
        const aiPattern = /^(AI|GPT|LABEL_1|FAKE|MACHINE|GENERATED)$/i;
        const aiProb = aiPattern.test(top.label) ? top.score : 1 - top.score;
        row.mlScore = Math.round(aiProb * 100);
        row.mlLabel = top.label;
        row.mlConfidence = top.score;

        // Noisy-OR blend
        const h = row.heuristicScore / 100;
        const m = row.mlScore / 100;
        row.blendedScore = Math.round((1 - (1 - h) * (1 - m)) * 100);

        process.stdout.write(`  [${i}/${scored.length}] ML=${row.mlScore} H=${row.heuristicScore} blend=${row.blendedScore} (${row.label})\n`);
      } catch (e) {
        process.stdout.write(`  [${i}/${scored.length}] ML FAILED: ${e.message}\n`);
      }
    }
  }

  // ─── BUILD REPORT ───
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const RESULTS_DIR = path.join(__dirname, 'results');
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const reportPath = path.join(RESULTS_DIR, `${stamp}.md`);

  const lines = [];
  lines.push(`# Benchmark Report — ${stamp}`);
  lines.push('');
  lines.push(`- **Set**: \`${path.relative(process.cwd(), SET_PATH)}\``);
  lines.push(`- **Posts scored**: ${scored.length}`);
  lines.push(`- **Engine**: ${ENABLE_ML ? `heuristic + ML (model=${ML_MODEL}, dtype=${ML_DTYPE}, Noisy-OR blend)` : 'heuristic-only'}`);
  lines.push(`- **Primary threshold**: ${PRIMARY_THRESHOLD}`);
  lines.push('');

  // ── Headline section per variant ──
  lines.push('## Heuristic-only');
  lines.push('');
  lines.push(...variantTable('Heuristic', scored, 'heuristicScore'));

  if (ENABLE_ML) {
    lines.push('## ML-only (Fakespot RoBERTa)');
    lines.push('');
    lines.push(...variantTable('ML', scored, 'mlScore'));

    lines.push('## Blended (Noisy-OR — production pipeline)');
    lines.push('');
    lines.push(...variantTable('Blended', scored, 'blendedScore'));
  }

  // Per-source breakdown using whichever score is primary (blended if --ml else heuristic)
  const primaryField = ENABLE_ML ? 'blendedScore' : 'heuristicScore';
  const bySource = {};
  for (const r of scored) {
    const key = r.source.profileName || r.source.type;
    if (!bySource[key]) bySource[key] = [];
    bySource[key].push(r);
  }
  lines.push(`## Per-source (using ${primaryField})`);
  lines.push('');
  lines.push(`| Source | n | Labels | Mean | Min | Max |`);
  lines.push(`|---|---|---|---|---|---|`);
  for (const [src, group] of Object.entries(bySource)) {
    const scores = group.map(r => r[primaryField]).filter(x => x != null);
    if (scores.length === 0) continue;
    const mean = scores.reduce((s, v) => s + v, 0) / scores.length;
    const labels = [...new Set(group.map(r => r.label))];
    lines.push(`| ${src} | ${group.length} | ${labels.join(', ')} | ${fix(mean, 1)} | ${Math.min(...scores)} | ${Math.max(...scores)} |`);
  }
  lines.push('');

  // Misses + false positives (using primary)
  const failedRed = scored.filter(r => r.label === 'ai' && r[primaryField] != null && r[primaryField] < PRIMARY_THRESHOLD);
  const falsePos = scored.filter(r => r.label === 'human' && r[primaryField] != null && r[primaryField] >= PRIMARY_THRESHOLD);

  if (failedRed.length > 0) {
    lines.push(`## Misses: AI posts below threshold ${PRIMARY_THRESHOLD} (${failedRed.length}, primary=${primaryField})`);
    lines.push('');
    for (const r of failedRed.slice(0, 15)) {
      const cells = ENABLE_ML
        ? `H=${r.heuristicScore} ML=${r.mlScore} blend=${r.blendedScore}`
        : `H=${r.heuristicScore}`;
      lines.push(`- **${cells}** (V:${r.layers.vocabulary} S:${r.layers.structure} St:${r.layers.stylometry} L:${r.layers.linkedin}) — ${r.source.profileName || r.source.type} · ${r.wordCount}w`);
    }
    lines.push('');
  }
  if (falsePos.length > 0) {
    lines.push(`## False positives: human posts at/above threshold ${PRIMARY_THRESHOLD} (${falsePos.length})`);
    lines.push('');
    for (const r of falsePos.slice(0, 15)) {
      const cells = ENABLE_ML
        ? `H=${r.heuristicScore} ML=${r.mlScore} blend=${r.blendedScore}`
        : `H=${r.heuristicScore}`;
      lines.push(`- **${cells}** — ${r.source.profileName || r.source.type} · ${r.wordCount}w`);
    }
    lines.push('');
  }

  fs.writeFileSync(reportPath, lines.join('\n') + '\n');
  console.log(`\nReport written: ${path.relative(process.cwd(), reportPath)}`);

  // Drop text from raw dump (keep file small)
  const rawDump = scored.map(({ text, ...rest }) => rest);
  const rawPath = path.join(RESULTS_DIR, `${stamp}.json`);
  fs.writeFileSync(rawPath, JSON.stringify(rawDump, null, 2));
  console.log(`Raw scores:    ${path.relative(process.cwd(), rawPath)}`);
})().catch(err => {
  console.error('Harness failed:', err);
  process.exit(1);
});
