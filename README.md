# LinkedIn AI Detector

A Chrome extension that overlays an AI-likelihood score on every LinkedIn post in your feed. Local-first, privacy-respecting, open source.

> ⚠️ **Honest framing.** This is an **AI-pattern detector**, not a verdict.
> No detector — including this one — reliably distinguishes lightly-edited AI
> from human writing on LinkedIn. We measure heuristic signals and an ML
> probability, then leave interpretation to you.

---

## What it does

- Adds a colored badge (green / amber / red) in the top-right of every post in your LinkedIn feed.
- Clicking the badge expands a breakdown card showing per-layer scores (Vocabulary, Structure, Stylometry, LinkedIn-specific) and the top signals that fired.
- Combines a fast heuristic layer with a RoBERTa-based ML model running locally in your browser via [Transformers.js](https://github.com/huggingface/transformers.js).
- All scoring happens on your device. Nothing is sent to a server.

![screenshot placeholder — add screenshot before publishing](icons/icon128.png)

---

## How it works

Two scoring layers feed a single 0–100 score.

**Heuristic layer** runs synchronously, gives an instant score:

| Layer | Max | What it catches |
|---|---|---|
| Vocabulary | 30 | AI-fingerprint words and phrases ("delve into", "tapestry", communication artifacts) |
| Structure | 30 | Broetry format, rule-of-three lists, hook/story/lesson arcs, formulaic endings |
| Stylometry | 38 | Burstiness, lexical diversity, sentence-length variance, paragraph uniformity |
| LinkedIn-specific | 15 | Hashtag stuffing, scroll manipulation, emoji-as-structure |

Layers sum and cap at 100. Short posts (< 100 words) skip statistical detectors and get flagged `partial`.

**ML layer** runs asynchronously in a Chrome offscreen document. We use the [Fakespot RoBERTa AI detector](https://huggingface.co/amankrai28/fakespot-roberta-ai-detector-onnx) (ONNX-quantized for fast on-device inference).

**Blend** — when both finish, we combine via Noisy-OR:

```
final = 1 - (1 - heuristic/100) × (1 - ML/100)
```

This treats each layer as independent evidence. Neither can drag the other down; convergence amplifies.

The pattern database is based on Wikipedia's [Signs of AI writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing) article plus LinkedIn-specific patterns.

---

## Accuracy — what we actually know

We benchmark against a labeled set of LinkedIn posts (see `benchmark/`). On 22 hand-labeled, polished-AI posts from prolific thought-leader accounts, the blended engine recalls only **~32% at threshold 50**. The ML model alone catches even less. ZeroGPT, a popular consumer detector, has the same blind spot.

This matches the academic literature ([Dugan et al. 2024, RAID](https://arxiv.org/abs/2405.07940); [Sadasivan et al. 2023](https://arxiv.org/abs/2303.11156)) — current detectors collapse on paraphrased or lightly-edited AI.

**Take the score as a signal, not a verdict.** Use it to flag posts worth a closer read, not to make confident accusations.

---

## Install

### From Chrome Web Store *(coming soon)*

One-click install once published.

### Load unpacked (developers)

```bash
git clone https://github.com/amankrai28/linkedin-ai-detector.git
cd linkedin-ai-detector
npm install
npm run build   # produces build/offscreen.js + WASM
```

Then in Chrome:
1. Open `chrome://extensions/`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → select the `linkedin-ai-detector` folder
4. Visit `https://www.linkedin.com/feed/` — badges should appear within a few seconds

---

## Privacy

Local-first by design. See [PRIVACY.md](PRIVACY.md) for the full policy. Short version:

- **No telemetry.** No analytics, no error reporting, no usage tracking.
- **No server-side anything.** All scoring runs on your device.
- **Settings + stats** stored locally in `chrome.storage`. Cleared when you uninstall.
- **One-time model download** (~100 MB) from HuggingFace on first run, cached in your browser thereafter.

---

## Tech stack

- **Manifest V3** Chrome extension
- **Content script** ([`content.js`](content.js)) — post detection, see-more expansion, badge rendering, orchestration
- **Background service worker** ([`background.js`](background.js)) — settings, stats, offscreen document lifecycle, message relay
- **Offscreen document** ([`offscreen.js`](offscreen.js)) — runs the ML model via Transformers.js
- **Scoring engine** ([`scoring/`](scoring/)) — five modules: vocabulary, structure, stylometry, linkedin, engine (orchestrator)
- **UI** ([`ui/`](ui/)) — popup, breakdown card overlay
- **Benchmark harness** ([`benchmark/`](benchmark/)) — Node runner that scores a labeled set and emits metrics

---

## Development

```bash
npm install
npm run build           # rebuild bundle after any change to offscreen.js or scoring/*

# Benchmark — measure precision/recall/F1 on a labeled set
cd benchmark
node run.js             # heuristic-only
node run.js --ml        # adds the ML layer (downloads model on first run)
node run.js --ml --model "<huggingface-model-id>"   # swap detectors
```

The benchmark needs a `benchmark/labeled-set.json` you build yourself (it's gitignored — see [benchmark/README.md](benchmark/README.md) for the schema and collection workflow).

---

## Contributing

Open an issue or PR. Some good first contributions:

- Additional language packs (most patterns are English-specific)
- New ML model integrations (the harness makes swapping a one-line change)
- Better Chrome Web Store screenshots / icons
- LinkedIn DOM-resilience tests (LinkedIn changes its CSS classes often)

**One discipline rule**: new heuristic signals need **independent justification** (published lit, Wikipedia's "Signs of AI writing" article, or a hypothesis tested on held-out data). No adding patterns we noticed in five posts.

---

## Acknowledgements

- **Wikipedia's [Signs of AI writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing)** for the foundational pattern database
- **[Fakespot](https://huggingface.co/Fakespot)** for the RoBERTa AI detector model we fine-tune from
- **[Transformers.js](https://github.com/huggingface/transformers.js)** by Xenova for on-device ML in the browser
- **Academic detector literature** — Mitchell et al. (DetectGPT), Dugan et al. (RAID), Sadasivan et al., Su et al.

---

## License

MIT — see [LICENSE](LICENSE).

Not affiliated with LinkedIn. "LinkedIn" is a trademark of LinkedIn Corporation. This is an independent, personal-use research tool.
