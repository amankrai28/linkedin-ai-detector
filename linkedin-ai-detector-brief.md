# LinkedIn AI Detector — Chrome Extension Project Brief

## For: Claude Code Build

---

## 1. WHAT WE'RE BUILDING

A Chrome extension (Manifest V3) that detects AI-generated LinkedIn posts using a local, heuristic-based scoring engine. No API calls required for the free tier. The extension injects into LinkedIn's feed, reads post text from the DOM, scores each post against a 24-category AI pattern taxonomy, and overlays a subtle score badge on the post.

### Product positioning
- Free, local-first, zero-cost-to-operate
- Built specifically for LinkedIn's writing culture (not generic AI detection)
- Pattern database is research-backed (Wikipedia's "Signs of AI Writing" taxonomy)
- Optional "deep scan" via bring-your-own Claude API key (power user feature)

---

## 2. PROJECT STRUCTURE

```
linkedin-ai-detector/
├── manifest.json            # Chrome Manifest V3
├── content.js               # Injected into LinkedIn — reads posts from DOM
├── scoring/
│   ├── engine.js            # Main scoring orchestrator (combines all layers)
│   ├── vocabulary.js        # Pattern Category: AI vocabulary detection
│   ├── structure.js         # Pattern Category: structural/template detection
│   ├── stylometry.js        # Pattern Category: sentence stats, formatting
│   └── linkedin.js          # Pattern Category: platform-specific signals
├── data/
│   └── patterns.json        # The full pattern database (words, phrases, weights)
├── ui/
│   ├── overlay.js           # Score badge injected onto LinkedIn posts
│   ├── popup.html           # Extension popup (settings, API key, about)
│   └── popup.js             # Popup logic
├── api/
│   └── deepscan.js          # Optional Claude API deep scan (BYOK)
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── styles.css               # Overlay and badge styling
```

---

## 3. SCORING ARCHITECTURE

### Overview

Four detection layers, each with a max contribution. Raw scores sum to a theoretical max of 100, then get normalized against post length.

| Layer | Max Points | What it detects |
|-------|-----------|-----------------|
| Vocabulary Fingerprinting | 30 | AI-overrepresented words/phrases |
| Structural Patterns | 30 | Templates, formulas, formatting tricks |
| Stylometric Analysis | 25 | Statistical writing behavior |
| LinkedIn-Specific Signals | 15 | Platform gaming patterns |

### Final score bands

| Score | Label | Color |
|-------|-------|-------|
| 0–35 | Likely Human | Green |
| 36–65 | Mixed Signals | Yellow/Amber |
| 66–100 | Likely AI-Generated | Red |

### Post-length normalization

Short posts naturally trigger fewer signals. Normalize the raw score:
- Posts under 50 words: multiply raw score by 1.5x (fewer signals = each one matters more)
- Posts 50–200 words: no adjustment
- Posts over 200 words: multiply raw score by 0.85x (more words = more chance of false hits)
- Cap final score at 100

---

## 4. LAYER 1: VOCABULARY FINGERPRINTING (max 30 points)

Source: Wikipedia's "Signs of AI Writing" + humanizer skill pattern database.

### Tier 1 — Dead giveaways (3 points each, cap at 15)

These words/phrases are so statistically overrepresented in LLM output that their presence is a strong signal:

```
delve, tapestry (abstract), testament, landscape (abstract), pivotal,
unwavering, paramount, foster/fostering, leverage (non-finance context),
underscores, showcasing, encompassing, cultivating, intricate/intricacies,
interplay, indelible mark, enduring
```

### Tier 2 — Moderate signals (1.5 points each, cap at 12)

Common AI filler but occasionally used by humans:

```
"it's worth noting", "at the end of the day", "here's the kicker",
"let me be clear", "in today's rapidly evolving", "at its core",
"the reality is", "here's the thing", "let that sink in",
"game-changer", "deep dive", "unpack (abstract)", "double down",
"move the needle", "lean into", "circle back", "it goes without saying",
"needless to say", "when it comes to", "in a world where",
"it is important to note", "this is a reminder that"
```

### Tier 3 — Contextual signals (0.5 points each, 2x multiplier if 3+ co-occur, cap at 8)

Fine individually, suspicious in clusters:

```
additionally, align with, crucial, enhance, garner, highlight (verb),
key (adjective), robust, streamline, holistic, navigate, innovative,
comprehensive, leverage, optimize, synergy, ecosystem, scalable,
actionable, impactful, empower, elevate, resonate, curate, craft
```

### Special patterns — Copula avoidance (2 points each, cap at 6)

LLMs substitute elaborate constructions for simple "is/are/has":

```
"serves as", "stands as", "marks a", "represents a",
"boasts a", "features a", "offers a"
```

### Special patterns — Communication artifacts (4 points each, cap at 8)

Dead giveaway that text was pasted from a chatbot:

```
"I hope this helps", "Great question!", "Certainly!", "Of course!",
"You're absolutely right", "Would you like me to", "Let me know if",
"Here is a", "As of my last", "based on available information"
```

---

## 5. LAYER 2: STRUCTURAL PATTERN DETECTION (max 30 points)

### Broetry format (0–8 points)

LinkedIn "broetry" = single-sentence paragraphs stacked vertically for dramatic scroll effect.

Detection: Split post into paragraphs. If >60% of paragraphs are a single sentence, score 8. If 40–60%, score 4.

### Hook-Story-Lesson-CTA arc (0–10 points)

The classic AI-optimized LinkedIn template:
1. **Hook** (first 1-2 sentences): Provocative claim, question, or surprising statement
2. **Story** (middle): Brief personal anecdote or scenario
3. **Lesson** (later): Generalized takeaway ("Here's what I learned")
4. **CTA** (ending): Engagement prompt ("Agree?", "Thoughts?", "Share if this resonated")

Detection approach:
- Hook: First sentence contains a question, exclamation, or strong claim? (+2)
- Story: Contains first-person narrative markers ("I was", "I remember", "Last week")? (+2)
- Lesson: Contains lesson markers ("Here's what I learned", "The lesson", "Key takeaway", "What this taught me")? (+3)
- CTA: Last sentence is a question or contains engagement prompts? (+3)

### Numbered wisdom lists (0–7 points)

Pattern: "X things I learned about Y" with each point being 1-2 sentences.

Detection: Post starts with a number + topic pattern, followed by numbered/bulleted items. Score 7 if detected.

### Formulaic endings (0–5 points)

Detect ending patterns:
- "Agree?" / "Thoughts?" / "What do you think?" (+3)
- "Repost if this resonated" / "Share if you agree" / "Tag someone who needs this" (+5)
- "Follow me for more" / "Follow for daily insights" (+4)

### Negative parallelisms (0–4 points)

"It's not just about X; it's about Y" or "Not only... but also..."

Detection: Regex for "not just|not only|it's not about.*it's about". Score 2 per instance, cap at 4.

### Rule of three (0–4 points)

LLMs force everything into groups of three.

Detection: Count comma-separated lists of exactly 3 items. If 2+ such lists appear in a post, score 4. If 1, score 2.

### False ranges (0–3 points)

"From X to Y, from A to B" constructions.

Detection: Regex for "from .+ to .+, from .+ to". Score 3 if found.

---

## 6. LAYER 3: STYLOMETRIC ANALYSIS (max 25 points)

### Sentence length variance (0–8 points)

Humans write with high variance (some 4-word sentences, some 30-word). AI clusters around 15-20 words with low standard deviation.

Detection:
1. Split post into sentences
2. Calculate mean sentence length (words)
3. Calculate coefficient of variation (CV = std_dev / mean)
4. If CV < 0.3 → score 8 (very uniform = AI-like)
5. If CV 0.3–0.5 → score 4
6. If CV > 0.5 → score 0 (high variance = human-like)

Minimum 4 sentences required to score this.

### Em dash density (0–4 points)

LLMs overuse em dashes (—).

Detection: Count em dashes per 100 words.
- 0-1 per 100 words → 0 points
- 2-3 per 100 words → 2 points
- 4+ per 100 words → 4 points

### Paragraph length uniformity (0–4 points)

Humans write uneven paragraphs. AI tends toward uniform length.

Detection: Calculate CV of paragraph lengths (in words). If CV < 0.3 → score 4. If 0.3–0.5 → score 2.

Minimum 3 paragraphs required.

### Hedging density (0–4 points)

AI over-qualifies: "perhaps", "it could be argued", "potentially", "it might be said", "arguably".

Detection: Count hedging phrases per 100 words. If >3 per 100 words → score 4. If 2-3 → score 2.

### Perfect grammar signal (0–3 points)

AI text has suspiciously zero contractions and zero colloquialisms in casual contexts.

Detection: If post length > 100 words AND zero contractions (don't, can't, won't, I'm, etc.) AND context appears casual (not academic/legal) → score 3.

### Superficial -ing phrases (0–2 points)

AI tacks participial phrases for fake depth: "highlighting...", "underscoring...", "emphasizing...", "reflecting...", "showcasing...".

Detection: Count instances of these trailing -ing constructions. If 2+ → score 2. If 1 → score 1.

---

## 7. LAYER 4: LINKEDIN-SPECIFIC SIGNALS (max 15 points)

### Hashtag stuffing (0–3 points)

More than 5 hashtags clustered at the bottom of a post.

Detection: Count hashtags in the last 20% of post text. If >5 → score 3. If 3-5 → score 1.

### Emoji as structure (0–4 points)

Emojis used as bullet points or section dividers.

Detection: Regex for emoji followed by bold/caps text pattern, or emoji at start of consecutive lines. Score 4 if 3+ instances. Score 2 if 1-2 instances.

### Personal brand formula (0–5 points)

Opening with "I" statements + humble-brag wrapped in vulnerability.

Detection heuristics:
- Post starts with "I was rejected/fired/told no/failed" → +2
- Followed by a success story or reversal → +2
- Contains "Here's what I learned" or equivalent → +1

### Scroll manipulation (0–3 points)

Excessive line breaks creating artificial whitespace to increase scroll length.

Detection: Count blank lines or single-word paragraphs. If ratio of blank lines to content lines > 0.5 → score 3.

---

## 8. CONTENT SCRIPT — DOM INTEGRATION

### LinkedIn's post structure

LinkedIn renders posts within feed items. The content script needs to:

1. **Find posts**: LinkedIn uses `div.feed-shared-update-v2` or similar containers (class names change — use attribute selectors or traverse the DOM structure)
2. **Extract text**: Look for `div.feed-shared-text` or `span.break-words` within post containers
3. **Handle "see more"**: Some posts are truncated — the visible text is what we score (don't click "see more" programmatically)
4. **Inject overlay**: Add a small badge element relative to the post container
5. **Use MutationObserver**: LinkedIn loads posts dynamically as user scrolls — watch for new DOM nodes

### Performance considerations

- Debounce scoring: don't re-score posts already processed
- Mark processed posts with a data attribute (`data-ai-scored="true"`)
- Run scoring asynchronously to avoid blocking the main thread
- Only score posts that are visible in the viewport (IntersectionObserver)

---

## 9. UI DESIGN

### Score badge (overlay on each post)

Small, non-intrusive badge in the top-right corner of each post:
- Circle with score number (0-100)
- Color-coded: green / amber / red
- Click to expand: shows breakdown by layer
- Tooltip on hover: "AI Pattern Score: X/100"

### Expanded breakdown (on click)

A small card showing:
```
AI Pattern Score: 72/100

Vocabulary:     ████████░░ 24/30
Structure:      ██████░░░░ 18/30
Stylometry:     █████░░░░░ 16/25
LinkedIn:       ██████████ 14/15

Top signals detected:
• "serves as", "tapestry", "delve" (vocabulary)
• Hook-Story-Lesson-CTA template (structure)
• Low sentence length variance (stylometry)
• 8 hashtags clustered at end (LinkedIn)
```

### Extension popup (popup.html)

- Toggle: Enable/disable extension
- Display mode: Badge only / Badge + expanded / Off
- Deep scan settings: API key input field (stored in chrome.storage.local)
- About: Brief description, link to pattern source
- Stats: Posts scanned this session, average score

---

## 10. DEEP SCAN (OPTIONAL — BRING YOUR OWN KEY)

For users who provide their own Anthropic API key:

### "Deep Scan" button

Appears on each post alongside the heuristic badge. On click:
1. Sends post text to Claude Haiku (cheapest model)
2. System prompt asks Claude to evaluate:
   - Semantic coherence and originality
   - Whether ideas feel derivative vs. novel
   - Stylistic consistency within the post
   - Likelihood of AI generation (0-100)
   - Natural language explanation of reasoning
3. Displays result in an expanded card

### API call structure

```javascript
const response = await fetch('https://api.anthropic.com/v1/messages', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-api-key': userApiKey, // from chrome.storage.local
    'anthropic-version': '2023-06-01'
  },
  body: JSON.stringify({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 500,
    messages: [{
      role: 'user',
      content: `Analyze this LinkedIn post for signs of AI generation. Score 0-100 where 100 = definitely AI. Explain your reasoning in 2-3 sentences. Respond in JSON: {"score": number, "explanation": string, "signals": string[]}\n\nPost:\n${postText}`
    }]
  })
});
```

---

## 11. THE PATTERN DATABASE — FULL REFERENCE

This is the foundation of the scoring engine. It comes from Wikipedia's "Signs of AI Writing" page (maintained by WikiProject AI Cleanup), which documents patterns observed across thousands of instances of AI-generated text.

### Category 1: Significance inflation
Words/phrases: stands/serves as, is a testament/reminder, a vital/significant/crucial/pivotal/key role/moment, underscores/highlights its importance/significance, reflects broader, symbolizing its ongoing/enduring/lasting, contributing to the, setting the stage for, marking/shaping the, represents/marks a shift, key turning point, evolving landscape, focal point, indelible mark, deeply rooted

### Category 2: Notability emphasis
Words/phrases: independent coverage, local/regional/national media outlets, written by a leading expert, active social media presence

### Category 3: Superficial -ing analyses
Words/phrases: highlighting, underscoring, emphasizing, ensuring, reflecting, symbolizing, contributing to, cultivating, fostering, encompassing, showcasing

### Category 4: Promotional language
Words/phrases: boasts a, vibrant, rich (figurative), profound, enhancing its, showcasing, exemplifies, commitment to, natural beauty, nestled, in the heart of, groundbreaking (figurative), renowned, breathtaking, must-visit, stunning

### Category 5: Vague attributions
Words/phrases: Industry reports, Observers have cited, Experts argue, Some critics argue, several sources/publications

### Category 6: Challenges and future prospects formula
Words/phrases: Despite its... faces several challenges..., Despite these challenges, Challenges and Legacy, Future Outlook

### Category 7: AI vocabulary (high-frequency)
Words: Additionally, align with, crucial, delve, emphasizing, enduring, enhance, fostering, garner, highlight (verb), interplay, intricate/intricacies, key (adjective), landscape (abstract noun), pivotal, showcase, tapestry (abstract noun), testament, underscore (verb), valuable, vibrant

### Category 8: Copula avoidance
Patterns: serves as/stands as/marks/represents [a], boasts/features/offers [a]

### Category 9: Negative parallelisms
Patterns: "Not only...but...", "It's not just about..., it's..."

### Category 10: Rule of three
Pattern: Forcing ideas into groups of exactly three

### Category 11: Synonym cycling
Pattern: Referring to the same entity by multiple different names to avoid repetition (protagonist → main character → central figure → hero)

### Category 12: False ranges
Pattern: "from X to Y, from A to B" where X/Y and A/B aren't on meaningful scales

### Category 13: Em dash overuse
Pattern: Using em dashes (—) far more frequently than human writing norms

### Category 14: Boldface overuse
Pattern: Mechanically emphasizing phrases in bold

### Category 15: Inline-header vertical lists
Pattern: Bullet points starting with **Bold Header:** followed by explanation

### Category 16: Title case in headings
Pattern: Capitalizing All Main Words In Every Heading

### Category 17: Emoji decoration
Pattern: Using emojis as bullet points or section markers (🚀 💡 ✅)

### Category 18: Curly quotation marks
Pattern: ChatGPT uses curly quotes ("...") vs straight quotes ("...")

### Category 19: Communication artifacts
Words/phrases: "I hope this helps", "Of course!", "Certainly!", "You're absolutely right!", "Would you like...", "Let me know", "Here is a..."

### Category 20: Knowledge-cutoff disclaimers
Words/phrases: "as of [date]", "Up to my last training update", "While specific details are limited/scarce...", "based on available information..."

### Category 21: Sycophantic tone
Words/phrases: "Great question!", "You're absolutely right!", "That's an excellent point"

### Category 22: Filler phrases
Examples: "In order to" → "To", "Due to the fact that" → "Because", "At this point in time" → "Now", "It is important to note that" → (delete)

### Category 23: Excessive hedging
Pattern: Over-qualifying statements ("could potentially possibly be argued that it might")

### Category 24: Generic positive conclusions
Pattern: Vague upbeat endings ("The future looks bright", "Exciting times lie ahead", "This represents a major step in the right direction")

---

## 12. MANIFEST V3 CONFIGURATION

```json
{
  "manifest_version": 3,
  "name": "LinkedIn AI Detector",
  "version": "1.0.0",
  "description": "Detect AI-generated LinkedIn posts with a research-backed scoring engine",
  "permissions": ["storage", "activeTab"],
  "host_permissions": ["https://www.linkedin.com/*"],
  "content_scripts": [
    {
      "matches": ["https://www.linkedin.com/*"],
      "js": ["content.js"],
      "css": ["styles.css"],
      "run_at": "document_idle"
    }
  ],
  "action": {
    "default_popup": "ui/popup.html",
    "default_icon": {
      "16": "icons/icon16.png",
      "48": "icons/icon48.png",
      "128": "icons/icon128.png"
    }
  },
  "icons": {
    "16": "icons/icon16.png",
    "48": "icons/icon48.png",
    "128": "icons/icon128.png"
  }
}
```

---

## 13. BUILD ORDER

### Phase 1: Foundation
1. `manifest.json` — extension config
2. `content.js` — inject into LinkedIn, find and extract post text
3. `ui/overlay.js` — render a simple badge on posts (hardcoded score for testing)
4. `styles.css` — badge styling

### Phase 2: Scoring engine
5. `data/patterns.json` — full pattern database with words, phrases, regex patterns, weights
6. `scoring/vocabulary.js` — vocabulary fingerprinting layer
7. `scoring/structure.js` — structural pattern detection layer
8. `scoring/stylometry.js` — stylometric analysis layer
9. `scoring/linkedin.js` — LinkedIn-specific signals layer
10. `scoring/engine.js` — orchestrator that combines all layers

### Phase 3: UI polish
11. `ui/overlay.js` — expanded breakdown card on click
12. `ui/popup.html` + `ui/popup.js` — extension settings popup
13. Icon design (can be simple SVG-based)

### Phase 4: Deep scan (optional)
14. `api/deepscan.js` — Claude API integration
15. API key management in popup settings

---

## 14. TESTING APPROACH

### Manual testing
1. Load as unpacked extension in Chrome
2. Navigate to LinkedIn feed
3. Check that posts are detected and scored
4. Verify scores make intuitive sense:
   - Your own thoughtful posts should score low (0-35)
   - Obviously AI-generated "thought leader" posts should score high (66+)
   - Mixed/edited content should land in the middle

### Test corpus
Create a few test posts:
- Pure ChatGPT output (ask ChatGPT to write a LinkedIn post about leadership)
- Pure human writing (grab your own old LinkedIn posts)
- AI-written then lightly edited
- Well-written human post that happens to use some AI vocabulary

---

## 15. IMPORTANT NOTES

### Accuracy expectations
This heuristic approach will catch ~70-80% of lazy, unedited AI posts. It will miss well-edited AI posts and may occasionally false-flag polished human writers. This is a feature, not a bug — frame it honestly in the UI as "AI Pattern Score" not "AI Certainty."

### LinkedIn DOM stability
LinkedIn changes their DOM structure regularly. The content script should be resilient:
- Use multiple selector strategies with fallbacks
- Log warnings when expected elements aren't found
- Make selectors easy to update in one place

### Privacy
The extension runs entirely locally. No data leaves the browser unless the user explicitly triggers a deep scan with their own API key. This is a strong selling point.

### Legal/ethical framing
The tool detects patterns, not intent. Someone might use AI as a drafting tool and edit heavily — that's legitimate. The score reflects surface-level pattern matches, not a judgment on the person. The UI copy should reflect this nuance.
