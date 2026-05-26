# Privacy Policy

**LinkedIn AI Detector**
Last updated: 2026-05-25

---

## TL;DR

LinkedIn AI Detector runs entirely on your device. We don't have a server, we don't collect any data about you, and we don't track what you read. The only network requests the extension makes are (a) a one-time download of an open-source ML model from HuggingFace on first install, and (b) an optional, opt-in API call to Anthropic if you provide your own Claude API key for the "Deep Scan" feature (not yet released).

---

## What this extension does on your device

When you visit linkedin.com, the extension's content script:

1. Reads the text of posts visible in your feed (same data already on your screen).
2. Runs that text through a heuristic scoring engine and an ML model — both executing locally in your browser.
3. Overlays a colored badge on each post showing the resulting 0–100 score.

The text never leaves your browser.

---

## What data the extension stores

| Storage | Contents | Where | Cleared when |
|---|---|---|---|
| `chrome.storage.local` | Your settings (enabled on/off, optional Claude API key) | On your device only | You uninstall the extension or click "Reset" |
| `chrome.storage.session` | Session stats: count of posts scanned, average score, green/amber/red distribution | On your device only, in-memory | You close the browser |
| Browser cache | The downloaded ML model (~100 MB), cached by Transformers.js | On your device only | You clear browser data |

We do not store the content of any post you view.

---

## Network requests

The extension makes exactly two kinds of network requests:

1. **First-run model download** — when the extension is first installed, it downloads an open-source ONNX-quantized RoBERTa model from [HuggingFace](https://huggingface.co/amankrai28/fakespot-roberta-ai-detector-onnx). This is a one-time download (~100 MB), cached by your browser. HuggingFace sees a standard model-fetch request; they do not see any post content.

2. **Optional "Deep Scan" (not yet released)** — a planned feature that would let you provide your own Anthropic API key (BYOK — Bring Your Own Key) for LLM-based verification of ambiguous posts. If and when this ships:
   - The feature is **off by default**.
   - You explicitly enter your own API key in the extension popup.
   - When the feature is on, post text is sent to Anthropic's API for analysis. This is your direct connection to Anthropic — we don't proxy it.
   - You can revoke the key at any time by clearing the field.

No other network requests. No analytics. No telemetry. No crash reports.

---

## What we don't do

- We don't track which posts you read.
- We don't track which posts you score, dismiss, or interact with.
- We don't collect anonymized usage data.
- We don't share, sell, or transmit any of your data — because we don't have any of it on a server to share.
- We don't store the content of LinkedIn posts.
- We don't use third-party analytics (no Google Analytics, no Mixpanel, no Sentry, nothing).

---

## Open source

The extension's entire source code is publicly available at <https://github.com/amankrai28/linkedin-ai-detector>. You can read every line of code that runs in your browser. If you find a privacy concern, please open an issue.

---

## Third-party services we touch

| Service | What is sent | When | Why |
|---|---|---|---|
| HuggingFace | Standard model-download HTTP request | First run only | Download the open-source RoBERTa ML model |
| Anthropic API | Post text (only if you opt in with your own API key) | Per-post when Deep Scan is enabled | Verify ambiguous posts via Claude |

That's the complete list.

---

## Permissions the extension requests

| Permission | Why |
|---|---|
| `storage` | Save your settings (enabled on/off, etc.) locally |
| `offscreen` | Host the ML model in a hidden background document so heavy ML runs don't block LinkedIn's UI |
| `host_permissions: https://www.linkedin.com/*` | Inject the content script that reads visible post text |
| `web_accessible_resources` | Serve the WASM runtime to the offscreen document |

We do not request `tabs`, `cookies`, `webNavigation`, `webRequest`, or any other broad-access permissions.

---

## Children's privacy

The extension is not directed at children under 13. We collect no data, so there's nothing to delete on request, but if you're a parent who wants to make sure your child isn't using this, simply uninstall the extension.

---

## Changes to this policy

If we ever change anything that affects what data the extension touches, we'll update this file and the version number in `manifest.json`. The full history is visible in this repository's `git log`.

---

## Contact

Questions, concerns, or privacy issues: open an issue at <https://github.com/amankrai28/linkedin-ai-detector/issues>.

---

Not affiliated with LinkedIn Corporation.
