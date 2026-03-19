# Phase 3: UI Polish — Implementation Plan

## Overview
Phase 3 adds the user-facing UI layer: a click-to-expand detail card on score badges, the extension popup for settings/stats, and proper icons.

---

## Step 1: Expanded Breakdown Card (click badge to see details)

**Files:** `ui/overlay.js`, `styles.css`

When the user clicks a score badge, show a card anchored to the badge with:
- Overall score + label (e.g. "AI Pattern Score: 72/100 — Likely AI-Generated")
- Per-layer progress bars with scores:
  - Vocabulary: 24/30
  - Structure: 18/30
  - Stylometry: 16/38
  - LinkedIn: 14/15
- Top signals list (up to 6 bullet points from `result.topSignals`)
- Word count and any flags (partial analysis, convergence bonus)
- Click outside or click badge again to dismiss

**Implementation details:**
- Add `createBreakdownCard(result)` function to `overlay.js` that builds the DOM card
- Add click handler to badge in `renderScoreBadge()` that toggles the card
- Close on outside click (document-level listener)
- All styles prefixed with `laid-` in `styles.css`
- Card positioned absolutely, anchored below the badge
- The card is a child of the post container (not body) to scroll with the post

---

## Step 2: Extension Popup (`popup.html` + `popup.js`)

**Files:** `ui/popup.html`, `ui/popup.js`

The popup shown when clicking the extension icon in the toolbar. Contains:

### 2a: Layout & structure (`popup.html`)
- Header: Extension name + version
- Toggle: Enable/disable extension (on/off switch)
- Display mode selector: "Badge only" / "Badge + auto-expand" / "Off"
- Session stats: Posts scanned, average score, score distribution (green/amber/red counts)
- Deep scan section (placeholder): API key input field (for Phase 4)
- Footer: Brief description + link to pattern source

### 2b: Logic (`popup.js`)
- Load/save settings via `chrome.storage.local`:
  - `enabled` (boolean, default true)
  - `displayMode` ("badge" | "badge-expand" | "off", default "badge")
  - `apiKey` (string, default "")
- Load/display session stats from `chrome.storage.session`:
  - `postsScanned` (number)
  - `totalScore` (number, for computing average)
  - `scoreBands` ({ green: number, amber: number, red: number })
- Send messages to content script when settings change

### 2c: Background service worker
**File:** `background.js`, update `manifest.json`

Needed to:
- Relay messages between popup and content scripts
- Track session stats (increment counts when content script reports a scored post)
- Initialize default settings on install

Add to manifest:
```json
"background": {
  "service_worker": "background.js"
}
```

### 2d: Content script integration
**File:** `content.js`

- On post scored: send message to background with score data
- On settings change (message from background): respect enabled/displayMode
- Check `enabled` flag before processing posts

---

## Step 3: Extension Icons

**Files:** `icons/icon16.png`, `icons/icon48.png`, `icons/icon128.png`

Generate simple SVG-based icons programmatically:
- Design: A shield or magnifying glass shape with "AI" text or a detection indicator
- Convert to PNG at 16x16, 48x48, 128x128 using canvas in a small generation script
- Alternatively, create clean SVG icons and use a build step

Since we can't run image editors, we'll create the icons as inline SVG data URIs in a Node.js script that writes PNGs, or create simple but recognizable icons using canvas drawing.

---

## Execution Order

1. **Step 2c** — Background service worker (other steps depend on messaging/storage)
2. **Step 2d** — Content script integration (settings awareness + stat reporting)
3. **Step 1** — Breakdown card (self-contained UI work)
4. **Step 2a+2b** — Popup UI (needs background worker running)
5. **Step 3** — Icons (independent, cosmetic)

---

## Files Changed/Created

| File | Action |
|------|--------|
| `background.js` | **Create** — service worker |
| `ui/popup.html` | **Create** — popup layout |
| `ui/popup.js` | **Create** — popup logic |
| `ui/overlay.js` | **Edit** — add breakdown card |
| `styles.css` | **Edit** — add card + popup styles |
| `content.js` | **Edit** — settings awareness + stat reporting |
| `manifest.json` | **Edit** — add background service worker |
| `icons/icon*.png` | **Replace** — proper icons |
