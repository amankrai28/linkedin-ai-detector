# Benchmark Harness

Measures how well the scoring engine separates AI-generated from human-written
LinkedIn posts on a labeled set. Designed for repeatable evaluation as we
tune heuristics, swap ML models, or recalibrate buckets.

## Files

| File | Committed | Purpose |
|---|---|---|
| `schema.json` | yes | JSON Schema for the labeled set. |
| `labeled-set.example.json` | yes | Small example showing the schema in use. |
| `labeled-set.json` | **no (gitignored)** | The real labeled set, kept local. Contains third-party LinkedIn post text. |
| `merge-extracted.js` | yes | Merges a downloaded extraction file into `labeled-set.json`. |
| `run.js` | yes | Loads the set, scores every post via the engine, writes a metrics report. |
| `results/` | **no (gitignored)** | Per-run reports + raw JSON. |
| `convert-model.sh` | yes | Existing — converts the Fakespot RoBERTa model to quantized ONNX. |

## Schema

Each labeled post has:

- `id` — stable identifier (LinkedIn activity URN, or a hash).
- `text` — full post body, with truncation expanded.
- `label` — `human`, `ai`, or `hybrid`.
- `ai_involvement` — `0.0..1.0` scalar:
  - `0.0` = end-to-end human
  - `0.2` = AI ideation only
  - `0.4` = AI drafts + heavy human edit
  - `0.7` = AI drafts + light edit
  - `0.9` = polished AI (heavy AI, light polish)
  - `1.0` = raw AI, no edit
- `confidence` — `high` (known provenance), `medium` (ensemble agreement), or `low`.
- `source` — `{ type, profileUrl?, profileName?, postUrl?, collectedAt }`.
- `tier2_scores` — external detector scores when available.
- `notes` — free text.

See `schema.json` for the full JSON Schema.

## Running

```bash
cd benchmark
node run.js                 # default threshold 50
node run.js --threshold 40  # try a different cutoff
node run.js --set my-set.json
```

Output: `results/<timestamp>.md` (human-readable report) and `results/<timestamp>.json` (raw per-post scores).

The report includes:

- Headline metrics (precision, recall, F1, accuracy) at the primary threshold
- Confusion matrices in two modes — strict (`ai` only is positive) and inclusive (`ai` + `hybrid` positive)
- Bucket accuracy mapped to the extension's color buckets (green ≤35 / amber 36-65 / red ≥66)
- Threshold sweep across 30/40/50/60/70
- Calibration table — does score X% really mean ~X% AI?
- Score distribution per label
- Per-source breakdown
- Examples of misses and false positives

## Adding new posts

Two paths:

**Extraction from a known profile** (used for `named-profile` AI labels):
1. Open the profile's `/recent-activity/all/` in Chrome.
2. Run the extraction JS in the page console; it triggers a JSON download.
3. `node merge-extracted.js <path> <profileName> <profileUrl>` — adds with `label=ai`, `ai_involvement=0.85`, `confidence=high`.

**Manual** (for self/friend posts, or Tier-2 ensemble-labeled feed posts):
Hand-edit `labeled-set.json`, or extend `merge-extracted.js` with another flag.

## Discipline

- New heuristic signals must have **independent justification** (published lit, Wikipedia "Signs of AI writing", or a hypothesis tested on held-out data — *not* the data that inspired it).
- Threshold tuning needs human-side data first. Tuning to AI-only labels makes false positives explode.
