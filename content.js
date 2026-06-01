/**
 * LinkedIn AI Detector — Content Script
 * Finds LinkedIn posts in the DOM, extracts text, and triggers badge rendering.
 */

// ─── SELECTORS (update here when LinkedIn changes their DOM) ───

const SELECTORS = {
  postContainer: [
    // Main feed selectors
    'div.feed-shared-update-v2',
    'div.feed-shared-update-v2[data-urn]',
    // Profile activity page selectors
    'div.profile-creator-shared-feed-update__container',
    'div.profile-creator-shared-feed-update__mini-container',
    'div.profile-creator-shared-feed-update__content',
    // Occludable update wrapper (used on activity/recent-activity pages)
    'div.occludable-update',
    // Article-based containers (LinkedIn sometimes wraps posts in <article>)
    'article.profile-creator-shared-feed-update__container',
    'article[data-urn]',
    // Activity URN-based selectors (works on both feed and profile pages)
    'div[data-urn^="urn:li:activity"]',
    'div[data-urn*="activity"]',
  ],
  postText: [
    'div.feed-shared-text',
    'span.break-words',
    'div.feed-shared-update-v2__description',
    'div.update-components-text',
    // Activity page text selectors
    'div.update-components-text__text-view',
    'div[class*="update-components-text"]',
    // Generic fallback: LTR text blocks within post containers
    'div[dir="ltr"]',
  ],
};

// Marker attribute applied to each post we've processed, so subsequent
// MutationObserver scans skip them. CRITICAL: this attribute name must be
// unique to this extension. LinkedIn themselves use `data-ai-scored="true"`
// on some of their feed components (verified via MCP probe on live DOM).
// If we shared the name, our `closest('[data-ai-scored]')` skip-check would
// false-match LinkedIn's wrappers and silently drop every post inside
// them — which manifested as "badges appear on the first few posts but
// stop showing on scrolled-in posts" since LinkedIn applies their marker
// on lazy-loaded subtrees only. Prefix is `laid` ("LinkedIn AI Detector").
const PROCESSED_ATTR = 'data-laid-scored';
// 300ms is long enough that scroll-induced mutation storms (LinkedIn updates
// reaction counts, hover state, tooltips, etc. constantly) coalesce into a
// single scan, but short enough that newly-loaded posts get badged before
// the user notices. Below 300ms processing starts mid-scroll-gesture and
// competes with the render pipeline.
const DEBOUNCE_MS = 300;
const LOG_PREFIX = '[AI Detector]';
// Per-post detail logs are noisy. Flip via DevTools console:
//   localStorage.setItem('laid_debug', '1'); then reload the page.
const DEBUG = (() => { try { return localStorage.getItem('laid_debug') === '1'; } catch (_) { return false; } })();
function dlog(...args) { if (DEBUG) console.log(LOG_PREFIX, ...args); }

// ─── FUNNEL INSTRUMENTATION ───
// Cumulative counters across the page lifetime. Incrementing is free (a
// property bump), so it runs unconditionally; only the *logging* is gated
// behind DEBUG, keeping production silent. The gaps between adjacent counters
// localize exactly where posts are dropped in the
// detect → route → score → badge pipeline:
//   deferredToIO − ioFired            = below-fold posts whose IntersectionObserver
//                                       never fired (LinkedIn detached them first)
//   (enqueuedDirect+ioFired) − entered = posts enqueued but processPost never ran
//                                        (serial queue dropped/never drained)
//   entered − badged                  = entered scoring but no badge (expansion
//                                        killed the text, or render threw)
//   skippedByMarker > 0               = candidates blocked by a PROCESSED_ATTR
//                                        ancestor (wide-ancestor swallow)
const _counters = {
  scans: 0,
  postsFound: 0,
  enqueuedDirect: 0,
  deferredToIO: 0,
  ioFired: 0,
  processPostEntered: 0,
  badgeRendered: 0,
  skippedByMarker: 0,
  recycled: 0, // marked+badged containers whose content fingerprint changed → re-scored
  bailMarked: 0,      // processPost entered but container already had the marker
  bailNoText: 0,      // processPost bailed: readPostText found no visible text
  bailRenderFail: 0,  // processPost bailed: renderHeuristicBadge returned false
  bailDisabled: 0,    // processPost bailed: extension disabled / displayMode 'off'
};
// One-line funnel dump plus a live DOM cross-check (badge + marker counts).
// The DOM counts cross the isolated/main world boundary, so an MCP driver can
// verify them independently of these in-page counters.
function dumpCounters(tag) {
  if (!DEBUG) return;
  const c = _counters;
  let badges = 0, marked = 0;
  try {
    badges = document.querySelectorAll('.laid-score-badge').length;
    marked = document.querySelectorAll(`[${PROCESSED_ATTR}]`).length;
  } catch (_) { /* querySelector can throw on a torn-down document */ }
  const frame = window !== window.top ? 'iframe' : 'top';
  const msg =
    `FUNNEL${tag ? ' [' + tag + ']' : ''} [${frame}] ` +
    `scans=${c.scans} found=${c.postsFound} ` +
    `direct=${c.enqueuedDirect} deferred=${c.deferredToIO} ioFired=${c.ioFired} ` +
    `entered=${c.processPostEntered} badged=${c.badgeRendered} ` +
    `skippedByMarker=${c.skippedByMarker} recycled=${c.recycled} ` +
    `bail[noText=${c.bailNoText} renderFail=${c.bailRenderFail} marked=${c.bailMarked} disabled=${c.bailDisabled}] ` +
    `settings[enabled=${extensionSettings && extensionSettings.enabled} mode=${extensionSettings && extensionSettings.displayMode} comments=${extensionSettings && extensionSettings.badgeComments}] ` +
    `|| DOM badges=${badges} marked=${marked}`;
  console.log(LOG_PREFIX, msg);
  // DOM beacon: stamp this frame's funnel onto <html> so a main-world MCP
  // driver reads THIS frame's state directly (crosses the isolated/main world
  // boundary), sidestepping flaky console capture + frame-attribution guesswork.
  try { document.documentElement.setAttribute('data-laid-funnel', msg); } catch (_) {}
  _badgeHud(badges, marked); // on-screen badge-health box for the foreground test
}

// On-screen BADGE-HEALTH HUD (top-left; the perf HUD is top-right). Shows live
// badge coverage + WHY posts fail to badge, so a single foreground screenshot
// diagnoses "badges stop showing up" — coverage = DOM badges vs # posts
// (control-menus), and the bail counters say whether posts are dying for no-text,
// a render failure, or just sitting deferred to an IntersectionObserver. DEBUG-only.
function _badgeHud(badges, marked) {
  if (!DEBUG) return;
  try {
    let hud = document.getElementById('laid-badge-hud');
    if (!hud) {
      hud = document.createElement('div');
      hud.id = 'laid-badge-hud';
      hud.style.cssText = 'position:fixed;top:8px;left:8px;z-index:2147483647;max-width:360px;' +
        'padding:6px 9px;background:rgba(10,10,12,0.9);color:#8ab4ff;' +
        'font:11px/1.45 ui-monospace,Menlo,Consolas,monospace;border-radius:6px;' +
        'pointer-events:none;white-space:pre-wrap;box-shadow:0 2px 8px rgba(0,0,0,0.45)';
      (document.body || document.documentElement).appendChild(hud);
    }
    const c = _counters;
    let posts = 0;
    try { posts = document.querySelectorAll('button[aria-label^="Open control menu for post by"]').length; } catch (_) {}
    hud.textContent =
      `BADGES on screen: ${badges}   posts visible(≈): ${posts}\n` +
      `found=${c.postsFound} entered=${c.processPostEntered} badged=${c.badgeRendered} marked=${marked}\n` +
      `bail: noText=${c.bailNoText} renderFail=${c.bailRenderFail} alreadyMarked=${c.bailMarked}\n` +
      `deferred=${c.deferredToIO} ioFired=${c.ioFired} recycled=${c.recycled} skipMarker=${c.skippedByMarker}`;
  } catch (_) { /* DOM not ready / detached */ }
}

// ─── SCROLL PROFILER (debug-gated) ───
// When scrolling is janky, this attributes main-thread time to OUR functions
// instead of guessing which one blocks frames. Counters reset at scroll-start;
// a one-line PERF report prints when the scroll settles — read it live from the
// console while scrolling the real foreground feed. Inert unless DEBUG.
//   frames/dropped/worst = rAF frame deltas during the gesture (dropped = a
//                          frame slower than ~32ms; worst = the single longest)
//   longtasks            = main-thread tasks >50ms (each is a visible hitch)
//   observer/scan/score  = cumulative time in those functions during the gesture
const _perf = {
  observer: { n: 0, ms: 0, muts: 0 }, // MutationObserver callback time + mutations seen
  scan:     { n: 0, ms: 0 },          // findPostContainers (the innerText-heavy scan)
  score:    { n: 0, ms: 0 },          // scorePostSync (heuristic CPU per post)
  process:  { n: 0, ms: 0 },          // full synchronous processPost body (per post)
  readtext: { n: 0, ms: 0 },          // readPostText — innerText read = forced reflow
  badge:    { n: 0, ms: 0 },          // renderScoreBadge — badge DOM insertion
  expand:   { n: 0, ms: 0 },          // expandAndUpgrade CSS-surgery spans (rect reads + scrollTop write = layout thrash)
  click:    { n: 0, ms: 0 },          // simulateClick(see-more) — triggers LinkedIn's SYNCHRONOUS re-render
  rescore:  { n: 0, ms: 0 },          // scorePostSync on the FULL expanded text (post-expansion re-score, uninstrumented before)
  longtasks: 0, longtaskMs: 0,
  frames: 0, dropped: 0, worstFrame: 0
};
// Session-cumulative WORST across all gestures since page load. Lets a single
// end-of-session screenshot capture the worst hitch regardless of when it hit,
// so the user doesn't have to time the screenshot to a janky moment.
const _perfSession = {
  gestures: 0, dropped: 0, worstFrame: 0,
  longtasks: 0, longtaskMs: 0, obsMs: 0, obsMuts: 0, scanMs: 0, scoreMs: 0,
  procMs: 0, readMs: 0, badgeMs: 0, expandMs: 0, clickMs: 0, rescoreMs: 0, clicks: 0
};
function _perfAdd(bucket, ms, muts) {
  if (!DEBUG) return;
  const b = _perf[bucket];
  if (!b) return;
  b.n++; b.ms += ms;
  if (muts) b.muts += muts;
}
function _perfReset() {
  _perf.observer = { n: 0, ms: 0, muts: 0 };
  _perf.scan = { n: 0, ms: 0 };
  _perf.score = { n: 0, ms: 0 };
  _perf.process = { n: 0, ms: 0 };
  _perf.readtext = { n: 0, ms: 0 };
  _perf.badge = { n: 0, ms: 0 };
  _perf.expand = { n: 0, ms: 0 };
  _perf.click = { n: 0, ms: 0 };
  _perf.rescore = { n: 0, ms: 0 };
  _perf.longtasks = 0; _perf.longtaskMs = 0;
  _perf.frames = 0; _perf.dropped = 0; _perf.worstFrame = 0;
}
function _perfReport(reason) {
  if (!DEBUG) return;
  const p = _perf;
  const S = _perfSession;
  S.gestures++;
  if (p.dropped > S.dropped) S.dropped = p.dropped;
  if (p.worstFrame > S.worstFrame) S.worstFrame = p.worstFrame;
  S.longtasks += p.longtasks; S.longtaskMs += p.longtaskMs;
  if (p.observer.ms > S.obsMs) S.obsMs = p.observer.ms;
  if (p.observer.muts > S.obsMuts) S.obsMuts = p.observer.muts;
  if (p.scan.ms > S.scanMs) S.scanMs = p.scan.ms;
  if (p.score.ms > S.scoreMs) S.scoreMs = p.score.ms;
  if (p.process.ms > S.procMs) S.procMs = p.process.ms;
  if (p.readtext.ms > S.readMs) S.readMs = p.readtext.ms;
  if (p.badge.ms > S.badgeMs) S.badgeMs = p.badge.ms;
  if (p.expand.ms > S.expandMs) S.expandMs = p.expand.ms;
  if (p.click.ms > S.clickMs) S.clickMs = p.click.ms;
  if (p.rescore.ms > S.rescoreMs) S.rescoreMs = p.rescore.ms;
  S.clicks += p.click.n;

  const L = _worstLoaf;
  const loaf = L
    ? `LoAF ${L.dur}ms blk=${L.block} layout=${L.layout} | ${L.src} sdur=${L.sdur} forced=${L.forced}${L.inv ? ' inv=' + L.inv : ''}`
    : 'LoAF none';

  const last =
    `PERF [${reason}] frames=${p.frames} dropped=${p.dropped} worst=${p.worstFrame.toFixed(0)}ms | ` +
    `longtasks=${p.longtasks} (${p.longtaskMs.toFixed(0)}ms) | process=${p.process.n}x ${p.process.ms.toFixed(0)}ms ` +
    `[read=${p.readtext.ms.toFixed(0)} score=${p.score.ms.toFixed(0)} badge=${p.badge.ms.toFixed(0)}] | ` +
    `scan=${p.scan.ms.toFixed(0)}ms | observer=${p.observer.ms.toFixed(0)}ms/${p.observer.muts}m | ` +
    `expand=${p.expand.ms.toFixed(0)}ms [click=${p.click.ms.toFixed(0)} rescore=${p.rescore.ms.toFixed(0)}]`;
  // Session WORST line — the one a single screenshot should capture.
  const worst =
    `WORST/${S.gestures}g  dropFrames=${S.dropped}  worstFrame=${S.worstFrame.toFixed(0)}ms  longtasks=${S.longtasks} (${S.longtaskMs.toFixed(0)}ms)\n` +
    `  process=${S.procMs.toFixed(0)}ms [read=${S.readMs.toFixed(0)} score=${S.scoreMs.toFixed(0)} badge=${S.badgeMs.toFixed(0)}]  ` +
    `scan=${S.scanMs.toFixed(0)}ms  observer=${S.obsMs.toFixed(0)}ms/${S.obsMuts}m\n` +
    `  expand=${S.expandMs.toFixed(0)}ms [click=${S.clickMs.toFixed(0)}ms/${S.clicks}x rescore=${S.rescoreMs.toFixed(0)}]\n` +
    `  ${loaf}`;
  console.log(LOG_PREFIX, last);
  // Reliable readouts that survive a backgrounded/foreign tab + flaky console
  // capture: stamp both lines onto <html> (read cross-world via MCP) AND paint
  // an on-page HUD so the jank numbers can be read/screenshotted directly off
  // whatever tab the user is actually scrolling. All DEBUG-only.
  try { document.documentElement.setAttribute('data-laid-perf', last); } catch (_) {}
  try { document.documentElement.setAttribute('data-laid-perf-worst', worst); } catch (_) {}
  _perfHud(worst + '\n' + last);
}

// On-page debug HUD: a fixed overlay showing the latest PERF line. pointer-events
// :none so it never blocks the page; DEBUG-only; removes itself when DEBUG is off.
function _perfHud(text) {
  if (!DEBUG) return;
  try {
    let hud = document.getElementById('laid-perf-hud');
    if (!hud) {
      hud = document.createElement('div');
      hud.id = 'laid-perf-hud';
      hud.style.cssText = 'position:fixed;top:8px;right:8px;z-index:2147483647;' +
        'max-width:380px;padding:6px 9px;background:rgba(10,10,12,0.88);color:#7CFC9A;' +
        'font:11px/1.45 ui-monospace,Menlo,Consolas,monospace;border-radius:6px;' +
        'pointer-events:none;white-space:pre-wrap;box-shadow:0 2px 8px rgba(0,0,0,0.45)';
      (document.body || document.documentElement).appendChild(hud);
    }
    hud.textContent = text;
  } catch (_) { /* DOM not ready / detached — non-fatal */ }
}

// Long-task observer: every main-thread task >50ms is a dropped frame or worse.
if (DEBUG && typeof PerformanceObserver === 'function') {
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) { _perf.longtasks++; _perf.longtaskMs += e.duration; }
    }).observe({ entryTypes: ['longtask'] });
  } catch (_) { /* longtask entryType unsupported — frame monitor still works */ }
}

// Long Animation Frame (LoAF) observer — Chrome 123+. The longtask observer
// only says "a 459ms task happened"; LoAF names the SCRIPT + FUNCTION + invoker
// behind the slow frame, and how much of it was forced style/layout. This is
// the tool for when no instrumented bucket catches the freeze: it attributes
// async-triggered work too (e.g. LinkedIn's React re-render scheduled AFTER our
// see-more click returns, which our synchronous click-timer can't see). We keep
// the single worst frame of the session so one screenshot names the culprit.
let _worstLoaf = null;
if (DEBUG && typeof PerformanceObserver === 'function') {
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.duration < 50) continue;
        if (_worstLoaf && e.duration <= _worstLoaf.dur) continue;
        let top = null; // the most expensive script in this frame
        for (const s of (e.scripts || [])) {
          if (!top || s.duration > top.duration) top = s;
        }
        _worstLoaf = {
          dur: Math.round(e.duration),
          block: Math.round(e.blockingDuration || 0),
          layout: Math.round(e.styleAndLayoutDuration || 0),
          src: top ? (((top.sourceURL || '').split('/').pop() || top.name || '?').slice(0, 28)
                + ':' + (top.sourceFunctionName || top.invokerType || '?')) : 'no-script-attrib',
          sdur: top ? Math.round(top.duration) : 0,
          forced: top ? Math.round(top.forcedStyleAndLayoutDuration || 0) : 0,
          inv: top ? String(top.invoker || top.invokerType || '').slice(0, 40) : ''
        };
      }
    }).observe({ entryTypes: ['long-animation-frame'] });
  } catch (_) { /* LoAF unsupported — longtask + frame monitor still report */ }
}

// Frame-drop monitor: a rAF loop that runs ONLY during an active scroll gesture
// (kicked by the scroll listener), counting frames and slow (>32ms) frames, then
// printing the PERF report once scrolling settles. rAF runs at full rate in the
// foreground, so this measures the real user gesture.
let _fmRunning = false, _fmLast = 0;
function _frameTick(ts) {
  if (!_fmRunning) return;
  if (_fmLast) {
    const d = ts - _fmLast;
    _perf.frames++;
    if (d > 32) _perf.dropped++;
    if (d > _perf.worstFrame) _perf.worstFrame = d;
  }
  _fmLast = ts;
  if (isUserScrolling()) {
    requestAnimationFrame(_frameTick);
  } else {
    _fmRunning = false; _fmLast = 0;
    _perfReport('scroll-settled');
  }
}
function startFrameMonitor() {
  if (!DEBUG || _fmRunning) return;
  _perfReset();
  _fmRunning = true; _fmLast = 0;
  requestAnimationFrame(_frameTick);
}

// ─── SETTINGS ───

let extensionSettings = { enabled: true, displayMode: 'badge', badgeComments: true };

// Load settings from background on init
try {
  chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, (settings) => {
    if (settings) extensionSettings = settings;
  });
} catch (e) {
  // Extension context may be invalidated
}

// Load any cached remote selector config (background.js fetches + refreshes it);
// no-op until it lands, since detection already runs on the bundled defaults.
loadRemoteConfig();

// Listen for settings changes from popup/background
try {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'SETTINGS_CHANGED') {
      extensionSettings = msg.settings;
      console.log(LOG_PREFIX, 'Settings updated:', extensionSettings);
      if (!extensionSettings.enabled || extensionSettings.displayMode === 'off') {
        document.querySelectorAll('.laid-score-badge').forEach(b => b.style.display = 'none');
      } else {
        document.querySelectorAll('.laid-score-badge').forEach(b => b.style.display = '');
      }
      // Comment badging toggled: badge them now if enabled, strip them if disabled.
      if (extensionSettings.badgeComments && extensionSettings.enabled) {
        try { processAllPosts(); } catch (_) {}
      } else if (!extensionSettings.badgeComments) {
        document.querySelectorAll('[data-laid-comment]').forEach(el => {
          try { clearProcessedState(el); el.removeAttribute('data-laid-comment'); } catch (_) {}
        });
      }
    }
    if (msg.type === 'CONFIG_UPDATED') {
      // background fetched a fresh remote selector config — apply it live + re-scan.
      if (applyRemoteConfig(msg.config)) processAllPosts();
    }
    if (msg.type === 'ML_MODEL_STATUS') {
      const s = msg.status;
      if (s === 'loading') console.log(LOG_PREFIX, `ML model loading${msg.attempt > 0 ? ` (retry ${msg.attempt})` : ''}...`);
      else if (s === 'ready') console.log(LOG_PREFIX, `ML model ready (${msg.elapsed}ms)`);
      else if (s === 'retrying') console.warn(LOG_PREFIX, `ML model load failed: ${msg.error} — retrying in ${msg.nextRetryMs / 1000}s`);
      else if (s === 'failed') console.error(LOG_PREFIX, `ML model failed to load after all retries: ${msg.error}`);
    }
    if (msg.type === 'ML_MODEL_READY') {
      console.log(LOG_PREFIX, 'ML model now ready — re-scoring posts');
      // Clear processed state so posts get re-scored with ML
      document.querySelectorAll(`[${PROCESSED_ATTR}]`).forEach(el => {
        el.removeAttribute(PROCESSED_ATTR);
        // Remove existing badges so they get re-rendered
        const badge = el.querySelector('.laid-score-badge');
        if (badge) badge.remove();
      });
      processAllPosts();
    }
  });
} catch (e) {
  // Extension context may be invalidated
}

// ─── DOM EXTRACTION ───

// Patterns that identify a short text line as LinkedIn meta-text (not
// authored post body): "X likes this", "Y reposted this", "Z follows Aman",
// "Promoted", "Suggested", etc. These are applied ONLY to candidates short
// enough to plausibly be a single meta line — see NON_BODY_MAX_LEN below.
// Applied to long bodies they would false-match on common words like
// "follow", "following", "followed" that legitimately appear in user
// content. A 1457-character post about AI startups can easily say "I
// followed up with…" without becoming a meta line.
const NON_BODY_TEXT_PATTERNS = [
  /\blikes? this\b/i,
  /\breposted (this|by)\b/i,
  /\bcommented on\b/i,
  /\bfollow(ed|s|ing)?\b/i,
  /^Promoted$/i,
  /^Suggested$/i,
];
// Apply NON_BODY filters only to text shorter than this. Meta-lines on
// LinkedIn (notifications, repost banners, "X follows Y") are essentially
// always <150 chars; real post bodies that hit the 50-char minimum can
// still legitimately contain words like "follow".
const NON_BODY_MAX_LEN = 150;

// Identifiers for per-post engagement controls. LinkedIn aggressively rotates
// classes and now (Dec 2026) renders Comment/Repost as <button> with no
// aria-label — only inner text — and Send as <a>. The reaction button's
// aria-label is "Reaction button state: no reaction" / "Open reactions menu",
// which the v1.0.2 regex /\breact\b/ missed because the substring "react" is
// inside the word "Reaction" (no word boundary). We now match on BOTH
// aria-label and inner text, with patterns that survive these wordings.
//
// `match` is permissive — these run only against engagement-control candidates
// (buttons + a-tags), so false positives are cheap and the upside is
// resilience against LinkedIn renaming the labels again.
const REACTION_MATCH = {
  label: /\b(reactions?|like|celebrate|support|love|insightful|funny)\b/i,
  text:  /^(like|react|celebrate|support|love|insightful|funny)$/i,
};
const COMMENT_MATCH = {
  label: /\bcomments?\b/i,
  text:  /^comments?$/i,
};
const SHARE_MATCH = {
  label: /\b(repost|share|send)\b/i,
  text:  /^(repost|share|send)$/i,
};
// Compact relative timestamps LinkedIn renders inline (e.g. "3h", "2d", "1w").
const TIMESTAMP_RE = /\b\d+[smhdwy]\b|^(Edited|Promoted)$/;
// LinkedIn profile-link path pattern.
const PROFILE_HREF_RE = /\/in\/[^/]+\/?/;
// Engagement-row text patterns: counts, "X and N others reacted" etc.
// These are post-context text but NOT body — never pick them as textEl.
const ENGAGEMENT_TEXT_PATTERNS = [
  /^\d+\s+comments?\s*$/i,
  /^\d+\s+reposts?\s*$/i,
  /and\s+\d+\s+others?\s+(reacted|liked|commented)/i,
  /^(reactions?|like|comment|repost|share|send)$/i,
];

// Roles/tags whose descendants should never count as post bodies (page chrome).
const CHROME_TAGS = new Set(['NAV', 'HEADER', 'ASIDE', 'FOOTER', 'SCRIPT', 'STYLE', 'BUTTON', 'A']);
const CHROME_ROLES = new Set(['navigation', 'banner', 'complementary', 'contentinfo', 'search']);

function isInsidePageChrome(el) {
  let cur = el;
  while (cur && cur !== document.body) {
    if (CHROME_TAGS.has(cur.tagName)) return true;
    const role = cur.getAttribute && cur.getAttribute('role');
    if (role && CHROME_ROLES.has(role)) return true;
    cur = cur.parentElement;
  }
  return false;
}

// Count semantic anchors near a candidate text element. We look at a broad
// scope around textEl — enough to capture the engagement bar that LinkedIn
// renders as a sibling of the body. Each engagement-control candidate
// (button or anchor tag) is matched on both aria-label and inner text, so
// we survive LinkedIn dropping aria-labels (current behavior on Comment
// and Repost) or rewording them ("Reaction button state: no reaction").
function findSemanticAnchors(textEl) {
  const anchors = { reactions: 0, comment: 0, share: 0, timestamp: 0, profile: 0, controlMenu: 0 };
  const anchorEls = [];

  // Scope: walk up ~5 ancestors so the engagement bar (a sibling of the
  // body wrapper) is captured. Capping ancestors at 5 prevents pulling in
  // other posts in the same scroll list.
  let scope = textEl.parentElement;
  for (let i = 0; i < 5 && scope && scope.parentElement && scope.parentElement !== document.body; i++) {
    scope = scope.parentElement;
  }
  if (!scope) scope = textEl.parentElement || textEl;

  // Engagement controls: both <button> and <a> (Send is rendered as <a>
  // in the current LinkedIn DOM). Plus role="button" for completeness.
  let ctrls;
  try { ctrls = scope.querySelectorAll('button, a, [role="button"]'); }
  catch (_) { return { count: 0, anchorEls }; }

  for (const el of ctrls) {
    const label = (el.getAttribute('aria-label') || '').trim();
    const text = (el.innerText || '').trim();

    // The control-menu button is the single most-reliable anchor — LinkedIn
    // must render it (accessibility) and its label uniquely identifies a
    // post (it includes the author name).
    if (label && /^Open control menu for post by/i.test(label)) {
      if (!anchors.controlMenu) { anchors.controlMenu = 1; anchorEls.push(el); }
      continue;
    }
    if ((label && REACTION_MATCH.label.test(label)) || (text && REACTION_MATCH.text.test(text))) {
      if (!anchors.reactions) { anchors.reactions = 1; anchorEls.push(el); }
      continue;
    }
    if ((label && COMMENT_MATCH.label.test(label)) || (text && COMMENT_MATCH.text.test(text))) {
      if (!anchors.comment) { anchors.comment = 1; anchorEls.push(el); }
      continue;
    }
    if ((label && SHARE_MATCH.label.test(label)) || (text && SHARE_MATCH.text.test(text))) {
      if (!anchors.share) { anchors.share = 1; anchorEls.push(el); }
      continue;
    }
  }

  // Author profile link
  try {
    const links = scope.querySelectorAll('a[href*="/in/"]');
    for (const a of links) {
      const href = a.getAttribute('href') || '';
      if (PROFILE_HREF_RE.test(href)) {
        anchors.profile = 1;
        anchorEls.push(a);
        break;
      }
    }
  } catch (_) {}

  // Timestamp / "Edited" / "Promoted" — look at small text nodes
  try {
    const spans = scope.querySelectorAll('span, time');
    for (const s of spans) {
      const t = (s.innerText || s.textContent || '').trim();
      if (!t || t.length > 12) continue;
      if (TIMESTAMP_RE.test(t)) {
        anchors.timestamp = 1;
        anchorEls.push(s);
        break;
      }
    }
  } catch (_) {}

  const count = anchors.reactions + anchors.comment + anchors.share +
                anchors.timestamp + anchors.profile + anchors.controlMenu;
  return { count, anchorEls };
}

// Lowest common ancestor of a set of elements.
function lowestCommonAncestor(elements) {
  if (!elements.length) return null;
  if (elements.length === 1) return elements[0];
  // Build ancestor chain for the first element
  const chain = [];
  let cur = elements[0];
  while (cur) { chain.push(cur); cur = cur.parentElement; }
  const chainSet = new Set(chain);
  // For each remaining element, walk up until we hit something in the chain
  let bestIdx = 0;
  for (let i = 1; i < elements.length; i++) {
    let e = elements[i];
    while (e && !chainSet.has(e)) e = e.parentElement;
    if (!e) return null;
    const idx = chain.indexOf(e);
    if (idx > bestIdx) bestIdx = idx;
  }
  return chain[bestIdx] || null;
}

// Tighten a candidate container: walk down from the LCA if it has only a
// single substantive child wrapping everything (avoids selecting <body>).
function tightenContainer(lca, textEl) {
  if (!lca || lca === document.body || lca === document.documentElement) {
    // Climb back up from textEl to a reasonably-sized ancestor
    let cur = textEl.parentElement;
    for (let i = 0; i < 6 && cur && cur !== document.body; i++) {
      if (cur.offsetHeight > 100) return cur;
      cur = cur.parentElement;
    }
    return cur;
  }
  return lca;
}

// ── Body-text picker ──
// Inside a known post container, find the element that holds the actual
// post body (not the author headline, not the reactions list, not the
// "21 comments" line, not video player controls). We try element types
// in order of reliability:
//   1. <p>                — semantic paragraph; LinkedIn's current body wrapper
//   2. span.break-words    — older LinkedIn body wrapper, still seen on profile pages
//   3. div[dir="ltr"]      — generic LTR text container, last resort because video
//                            player controls and other UI text live here too
// Within each tier we pick the LONGEST qualifying element. We only fall
// through to the next tier if the current one yields nothing — so video
// controls in <div> never beat a real <p> body in the same container.
function pickBodyTextElement(container) {
  for (const sel of ['p', 'span.break-words', 'div[dir="ltr"]']) {
    let best = null, bestLen = 0;
    let nodes;
    try { nodes = container.querySelectorAll(sel); }
    catch (_) { continue; }
    for (const el of nodes) {
      // Skip text inside engagement controls, links, or video players.
      if (el.closest('button, [role="button"], a, video')) continue;
      const text = (el.innerText || '').trim();
      if (text.length < 50) continue;
      // NON_BODY patterns target short meta-lines only — see comment on
      // NON_BODY_MAX_LEN. Applying them to long bodies false-rejects on
      // common words like "follow".
      if (text.length < NON_BODY_MAX_LEN && NON_BODY_TEXT_PATTERNS.some(re => re.test(text))) continue;
      if (ENGAGEMENT_TEXT_PATTERNS.some(re => re.test(text))) continue;
      if (text.length > bestLen) { best = el; bestLen = text.length; }
    }
    if (best) return best;
  }
  return null;
}

// ─── RECYCLE-SAFE DEDUP (content fingerprint) ───
// LinkedIn's virtual scroll RECYCLES a post's DOM node: it keeps the element but
// swaps in a different post's text. Our badge + PROCESSED_ATTR marker survive the
// swap, so a marker-only dedup skips the recycled node forever and shows the
// PREVIOUS post's score ("badges stop / are wrong on scroll-loaded posts"). We
// stamp a short content fingerprint beside the marker; when a marked+badged
// container's fingerprint no longer matches, it was recycled — we tear our overlay
// down and let the scan re-score the new content.
//   textContent (not innerText): reflow-free AND sees the full body even when it's
//   CSS-line-clamped, so the fingerprint is stable across see-more truncation ↔
//   expansion (the clamp only hides text visually; textContent always has it all).
//   The 40-char prefix is likewise expansion-stable (expansion appends, never
//   rewrites the opening), so expanding a post is never mistaken for a recycle.
const FINGERPRINT_ATTR = 'data-laid-fp';
function postFingerprint(container) {
  try {
    const el = (typeof pickBodyTextElement === 'function' && pickBodyTextElement(container)) || container;
    return (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  } catch (_) { return ''; }
}
// Remove our overlay + processed state from a container so the next scan re-scores
// it from scratch. Also used implicitly by the recycle path. NOTE: removing the
// badge is REQUIRED — renderScoreBadge refuses to render when a badge is already
// present (dup guard), so a leftover stale badge would block the re-score.
function clearProcessedState(container) {
  try {
    const badge = container.querySelector('.laid-score-badge');
    if (badge) badge.remove();
    const card = container.querySelector('.laid-breakdown-card');
    if (card) card.remove();
    const host = container.querySelector('.laid-host'); // present only if Fix B's host ships
    if (host) host.remove();
    container.classList.remove('laid-container');
    container.removeAttribute(PROCESSED_ATTR);
    container.removeAttribute(FINGERPRINT_ATTR);
  } catch (_) {}
}

// Find a post container starting from its control-menu button. The naive
// "walk up to the first ancestor that yields a body" strategy fails on
// LinkedIn's current DOM because the very first ancestor with a body <p>
// is often the *header* subtree — which contains the author's headline
// (a single 50+ char <p>) but NOT the post text itself.
//
// Robust strategy: walk the full ancestor chain, scoring each by the
// length of the body its pickBodyTextElement returns. Choose the ancestor
// whose body is longest. Stop the moment we ascend into a multi-post
// container (more than one control-menu button inside) — past that point
// we'd start picking other posts' bodies.
function findPostContainerFromControlMenu(btn) {
  let cur = btn.parentElement;
  let bestContainer = null, bestText = null, bestLen = 0;
  for (let i = 0; i < 15 && cur && cur !== document.body; i++) {
    // Stop walking if we've ascended above a single post's bounds.
    const cms = cur.querySelectorAll('button[aria-label^="Open control menu for post by"]');
    if (cms.length > 1) break;
    const textEl = pickBodyTextElement(cur);
    if (textEl) {
      const len = (textEl.innerText || '').trim().length;
      // Skip ancestors that don't generate a layout box — display:contents
      // wrappers report offsetHeight:0 and don't accept position:relative,
      // so a badge anchored here would visually escape the post bounds and
      // land at the next relative ancestor (usually the feed or viewport).
      const generatesBox = cur.offsetHeight > 0 || cur.offsetWidth > 0;
      if (generatesBox) {
        // `>=` so that on equal body lengths (very common — the same body
        // belongs to every ancestor between the body wrapper and the multi-
        // post container) we prefer the OUTERMOST. The badge then anchors
        // to the full post bounding box rather than an inner sub-region.
        if (len >= bestLen) {
          bestLen = len;
          bestContainer = cur;
          bestText = textEl;
        }
      }
    }
    cur = cur.parentElement;
  }
  return bestContainer ? { container: bestContainer, textEl: bestText } : null;
}

// ── Strategy 1 (primary): content-first ──
// This is the architectural cornerstone of v1.0.2. The premise: LinkedIn
// rotates classes, drops `data-urn`, renames aria-labels, and reshapes
// nesting — but they cannot change *what* a post fundamentally is, namely
// (substantial authored text) + (engagement controls) + (author profile
// link) + (timestamp). We find the text first, validate it sits near at
// least two of those signals, derive the container via lowest common
// ancestor, then re-pick the longest body <p> inside the resolved
// container so author headlines/reaction lists/video controls never beat
// the actual post body.
//
// The 2+ semantic-anchor threshold is the key durability lever: of the six
// anchor types we look for (reaction, comment, share, timestamp, profile,
// controlMenu), LinkedIn would have to remove or rename five of them
// simultaneously to break detection. Author profile link and timestamp
// alone are basically untouchable — LinkedIn cannot hide who wrote a post
// or when, and they're rendered as plain semantic HTML (`a[href*="/in/"]`
// and a short `\d+[smhdwy]` text node).
function findPostsContentFirst(root) {
  const results = []; // [{ container, textEl }]
  const seenTextEls = new Set();
  let candidates;
  try { candidates = root.querySelectorAll('p, span.break-words, div[dir="ltr"]'); }
  catch (_) { return results; }

  const confirmedSame = new Set(); // containers confirmed NOT-recycled this scan (memoize)
  for (const el of candidates) {
    if (seenTextEls.has(el)) continue;

    // Cheapest reject FIRST. The real feed renders ~29 <p> per post, most of them
    // short meta lines; rejecting on length before the deep ancestor walks
    // (isInsidePageChrome, closest — each ~21 levels) skips that work for the
    // majority of candidates. Those per-candidate walks over hundreds of candidates
    // were a major part of the ~53ms scan that runs every ~800ms during scroll.
    // innerText (not textContent): textContent pulls in HIDDEN / aggregated text,
    // which over-detected non-posts AND made the body-picker choose a hidden element
    // whose visible text is empty → a post detected but never badged (the live
    // badge-failure). innerText sees only what the user sees, matching scoring.
    const text = (el.innerText || '').trim();
    if (text.length < 50) continue;
    if (text.length < NON_BODY_MAX_LEN && NON_BODY_TEXT_PATTERNS.some(re => re.test(text))) continue;
    if (ENGAGEMENT_TEXT_PATTERNS.some(re => re.test(text))) continue;

    // Dedup + recycle check, MEMOIZED per container. Many long candidates can share
    // one already-scored container; without memoization the recycle fingerprint
    // (postFingerprint → a pickBodyTextElement querySelectorAll) re-ran for EACH,
    // which blew the scan up on heavy real posts. Self-heal: a marked ancestor with
    // no badge (failed run / too-wide marker) is cleared so it can't block forever.
    const blockingAncestor = el.closest(`[${PROCESSED_ATTR}]`);
    if (blockingAncestor) {
      if (confirmedSame.has(blockingAncestor)) { _counters.skippedByMarker++; continue; }
      if (!blockingAncestor.querySelector('.laid-score-badge')) {
        blockingAncestor.removeAttribute(PROCESSED_ATTR);
        blockingAncestor.removeAttribute(FINGERPRINT_ATTR);
      } else {
        const stamped = blockingAncestor.getAttribute(FINGERPRINT_ATTR);
        if (stamped != null && postFingerprint(blockingAncestor) !== stamped) {
          // RECYCLED: node reused for a new post but our badge survived. Tear our
          // overlay down and fall through to re-score (do NOT `continue`).
          _counters.recycled++;
          clearProcessedState(blockingAncestor);
        } else {
          confirmedSame.add(blockingAncestor);
          _counters.skippedByMarker++;
          continue;
        }
      }
    }

    if (isInsidePageChrome(el)) continue;

    // Past this point the candidate has substantial body-like text, so any
    // rejection below is a genuine near-miss — logged (DEBUG only) so a
    // "detection died on scrolled-in posts" failure names its own cause.
    const { count, anchorEls } = findSemanticAnchors(el);
    if (count < 2) { dlog(`MISS anchors=${count}<2: "${text.slice(0, 40)}"`); continue; }

    const lca = lowestCommonAncestor([el, ...anchorEls]);
    const container = tightenContainer(lca, el);
    if (!container || container === document.body) {
      dlog(`MISS container=${container === document.body ? 'body' : 'null'}: "${text.slice(0, 40)}"`);
      continue;
    }
    if (container.hasAttribute(PROCESSED_ATTR)) { _counters.skippedByMarker++; dlog(`MISS container-marked: "${text.slice(0, 40)}"`); continue; }
    if (container.closest(`[${PROCESSED_ATTR}]`)) { _counters.skippedByMarker++; dlog(`MISS ancestor-marked: "${text.slice(0, 40)}"`); continue; }

    // Re-pick body text from the resolved container — the candidate `el`
    // might be the author headline or another non-body <p>. The longest
    // qualifying <p> in the container is the real body.
    const bodyEl = pickBodyTextElement(container) || el;
    seenTextEls.add(bodyEl);
    results.push({ container, textEl: bodyEl });
  }
  return results;
}

// ── Strategy 2 (fallback): control-menu anchor ──
// A defensive fallback that catches posts content-first missed (e.g. the
// post has a body too short to clear the 50-char threshold, or LinkedIn
// suppressed a semantic anchor in some bucket). Looks for the
// "Open control menu for post by NAME" button — which LinkedIn must
// render for screen-reader accessibility — then walks up to the post
// container via findPostContainerFromControlMenu.
//
// This is INTENTIONALLY secondary. The aria-label string
// "Open control menu for post by" is a specific LinkedIn-owned wording
// that they could rename at any time (they've already renamed
// reaction-button labels and dropped Comment/Repost aria-labels). If
// content-first is doing its job, this fallback rarely fires.
function findPostsControlMenuFirst(root) {
  const results = [];
  let buttons;
  try { buttons = root.querySelectorAll('button[aria-label^="Open control menu for post by"]'); }
  catch (_) { return results; }
  for (const btn of buttons) {
    if (btn.closest(`[${PROCESSED_ATTR}]`)) continue;
    const found = findPostContainerFromControlMenu(btn);
    if (!found) continue;
    if (found.container.hasAttribute(PROCESSED_ATTR)) continue;
    if (found.container.closest(`[${PROCESSED_ATTR}]`)) continue;
    results.push(found);
  }
  return results;
}

// ── Strategy 3 (fallback): legacy class/data-urn selectors ──
// Retained for older LinkedIn buckets / cached pages. As of late 2026
// these selectors return nothing on the live feed — `data-urn` was
// dropped entirely — but they cost almost nothing to try.
function findPostsLegacySelectors(root, found) {
  for (const selector of SELECTORS.postContainer) {
    try {
      const elements = root.querySelectorAll(selector);
      elements.forEach((el) => {
        if (!el.hasAttribute(PROCESSED_ATTR) && !found.has(el)) {
          if (!el.closest(`[${PROCESSED_ATTR}]`)) {
            // Pick the body text element so processPost has a textEl too.
            const textEl = pickBodyTextElement(el);
            if (textEl) found.set(el, { source: selector, textEl });
          }
        }
      });
    } catch (e) {
      console.warn(LOG_PREFIX, 'Selector failed:', selector, e);
    }
  }
}

// ── DETECTION CONFIG — every LinkedIn-specific selector, in ONE place. ──
// Anchored on accessibility roles + data-testid, which LinkedIn changes far less
// often than its obfuscated CSS classes. Kept as a single object so a remotely
// fetched config can override it WITHOUT shipping a new extension package (see
// loadRemoteConfig() + background.js). When LinkedIn breaks detection, ideally only
// the hosted JSON changes, not the code — no Web Store review, no user update.
//   feedRoot:   ordered list of selectors; first match wins (the feed <list>).
//   postItem:   each post is one of these inside the feed (the ARIA list item).
//   postMarker: a listitem counts as a real user post only if it contains this
//               (the a11y control-menu button) — also filters ads/suggested/dividers.
const LAID_DEFAULT_CONFIG = {
  feedRoot: ['[data-testid="mainFeed"]', 'main [role="list"]', '[role="list"]'],
  postItem: '[role="listitem"]',
  postMarker: 'button[aria-label^="Open control menu for post by"]',
  // Per-comment anchor (opt-in comment badging). Each comment carries a "more
  // options for {name}'s comment" button — the comment equivalent of the post
  // control-menu, one per comment. Matching both "comment" + "option" avoids the
  // post control-menu ("…for post by…"), the compose box ("editor for creating
  // comment"), and "N more comments". Case-insensitive for resilience.
  commentMarker: 'button[aria-label*="comment" i][aria-label*="option" i]',
};
// Live config = bundled defaults, shallow-overridden by any valid remote config that
// background.js has cached into chrome.storage. Detection always reads LAID_CONFIG.
let LAID_CONFIG = { ...LAID_DEFAULT_CONFIG };
// Canary state: set true when detection looks broken (the page clearly has posts but
// we've badged none), which flips findPostContainers to the resilient heuristic
// fallback until a fresh remote config arrives or the page reloads.
let _forceLegacy = false;
let _canaryMisses = 0;

// Pull the cached remote selector config (fetched by background.js) and merge it over
// the bundled defaults. Best-effort: on ANY failure we keep the defaults, so
// detection never depends on the network. Re-applied when background pushes an update.
function applyRemoteConfig(remote) {
  try {
    if (remote && remote.selectors && typeof remote.selectors === 'object') {
      const next = { ...LAID_DEFAULT_CONFIG };
      for (const k of Object.keys(LAID_DEFAULT_CONFIG)) {
        if (remote.selectors[k]) next[k] = remote.selectors[k];
      }
      LAID_CONFIG = next;
      _forceLegacy = false; // a fresh config may fix detection — drop the canary fallback
      dlog('Applied remote selector config v' + (remote.version || '?'));
      return true;
    }
  } catch (_) { /* malformed remote config — keep defaults */ }
  return false;
}
function loadRemoteConfig() {
  try { chrome.storage.local.get('laid_config', (res) => applyRemoteConfig(res && res.laid_config)); }
  catch (_) { /* storage unavailable — keep bundled defaults */ }
}

// ── Feed root: the first configured feed-root selector that matches. ──
function findFeedRoot(root) {
  const r = root && root.querySelector ? root : document;
  const sels = (LAID_CONFIG && LAID_CONFIG.feedRoot) || LAID_DEFAULT_CONFIG.feedRoot;
  for (const sel of sels) {
    try { const el = r.querySelector(sel); if (el) return el; } catch (_) {}
  }
  return null;
}

// PRIMARY detection: one cheap, precise query over LinkedIn's ARIA list. Each post
// is a role="listitem" inside the feed's role="list" (data-testid="mainFeed") —
// verified 1:1 on the live feed (11 listitems = 11 control-menus = 11 posts). No
// content-guessing, no full-document scan, no over-detection: this is the modern
// stand-in for the data-urn lookup the extension used before LinkedIn obfuscated the
// DOM, and it's what makes the scan cheap (the jank) AND exact (the missing badges).
function findPostContainers(scopeRoot) {
  const root = scopeRoot && scopeRoot.querySelectorAll ? scopeRoot : document;
  // Canary fallback: if the breakage check tripped, use the resilient (slower)
  // heuristic strategies until a fresh config arrives or the page reloads.
  if (_forceLegacy) return findPostContainersLegacy(root);
  const feed = findFeedRoot(root);
  if (!feed) return findPostContainersLegacy(root); // old buckets / cached pages

  const results = [];
  const items = feed.querySelectorAll(LAID_CONFIG.postItem);
  for (const li of items) {
    if (li.querySelector(LAID_CONFIG.postItem)) continue; // skip nested (none today)
    // A user post carries the a11y control-menu button — this also filters out ads,
    // "suggested", and divider items that don't have one.
    if (!li.querySelector(LAID_CONFIG.postMarker)) continue;

    // Recycle-safe dedup: LinkedIn's LazyColumn reuses a listitem for a new post.
    // Already badged with the SAME body → skip (the common case). Body changed
    // (recycled) or marker stale → clear our state and let it re-score.
    if (li.hasAttribute(PROCESSED_ATTR)) {
      const stamped = li.getAttribute(FINGERPRINT_ATTR);
      if (li.querySelector('.laid-score-badge') && stamped != null && postFingerprint(li) === stamped) {
        _counters.skippedByMarker++;
        continue;
      }
      _counters.recycled++;
      clearProcessedState(li);
    }

    const textEl = pickBodyTextElement(li);
    if (!textEl) continue; // body not hydrated yet — a later scan catches it
    results.push({ container: li, textEl });
  }
  if (DEBUG) dlog(`listitem detection: ${results.length} needing work / ${items.length} items`);
  return results;
}

// Comment bodies are NOT in <p> (posts are) — they sit in obfuscated-class divs/
// spans, so pickBodyTextElement (p / span.break-words / div[dir=ltr]) misses them.
// Within the small, already-scoped comment container, pick the longest leaf-ish text
// element that isn't a control/link. Lower length floor than posts (comments are
// shorter); sub-threshold replies ("Great post!") stay unbadged — scoring those is noise.
function pickCommentBodyElement(container) {
  let best = null, bestLen = 0;
  let els;
  try { els = container.querySelectorAll('span, div, p'); } catch (_) { return null; }
  for (const el of els) {
    if (el.closest('button, [role="button"], a, video')) continue;
    if (el.children.length > 4) continue; // skip wrappers — want the text leaf
    const t = (el.textContent || '').trim();
    if (t.length < 30) continue;
    if (t.length < NON_BODY_MAX_LEN && NON_BODY_TEXT_PATTERNS.some(re => re.test(t))) continue;
    if (ENGAGEMENT_TEXT_PATTERNS.some(re => re.test(t))) continue;
    if (t.length > bestLen) { best = el; bestLen = t.length; }
  }
  return best;
}

// ── Comment detection (opt-in via the badgeComments setting). Each comment is
// anchored by its own "more options for {name}'s comment" button; we walk up to the
// largest ancestor that still bounds exactly that one comment (one more level up is
// the comment list, which holds 2+). Returns {container, textEl} just like posts, so
// comments flow through the SAME badge + recycle-safe-dedup pipeline. Cheap: the
// marker query returns nothing until comments are expanded.
function findCommentContainers(root) {
  const results = [];
  const sel = LAID_CONFIG.commentMarker;
  if (!sel) return results;
  let menus;
  try { menus = root.querySelectorAll(sel); } catch (_) { return results; }
  for (const btn of menus) {
    let container = null, cur = btn.parentElement, hops = 0;
    while (cur && cur !== document.body && hops < 8) {
      let cnt = 0;
      try { cnt = cur.querySelectorAll(sel).length; } catch (_) {}
      if (cnt !== 1) break; // ascended into the comment list — stop one below
      container = cur;
      cur = cur.parentElement; hops++;
    }
    if (!container) continue;
    // Recycle-safe dedup, identical to posts (the comment list is a LazyColumn too).
    if (container.hasAttribute(PROCESSED_ATTR)) {
      const stamped = container.getAttribute(FINGERPRINT_ATTR);
      if (container.querySelector('.laid-score-badge') && stamped != null && postFingerprint(container) === stamped) {
        _counters.skippedByMarker++; continue;
      }
      _counters.recycled++;
      clearProcessedState(container);
    }
    const textEl = pickCommentBodyElement(container);
    if (!textEl) continue;
    try { container.setAttribute('data-laid-comment', '1'); } catch (_) {} // tag so toggling off can strip them
    results.push({ container, textEl });
  }
  return results;
}

// LEGACY fallback — only when the semantic ARIA list is absent (old buckets / cached
// pages). The prior content-first + control-menu + class/data-urn strategies, kept
// off the hot path because they over-detect and cost a full-document scan.
function findPostContainersLegacy(root) {
  const found = new Map(); // container -> { source, textEl }

  // Strategy 1 (primary): content-first — survives any LinkedIn DOM
  // renaming because it relies only on the universal properties of a post.
  const cfResults = findPostsContentFirst(root);
  let cfCount = 0;
  for (const { container, textEl } of cfResults) {
    if (!found.has(container)) {
      found.set(container, { source: 'content-first', textEl });
      cfCount++;
    }
  }
  if (cfCount > 0) dlog(`Content-first strategy found ${cfCount} post(s)`);

  // Strategy 2 (fallback): control-menu anchor — defensive backstop for
  // posts content-first missed. Carries the LinkedIn aria-label dependency
  // we'd rather not rely on, so this fires rarely on a healthy feed.
  const cmResults = findPostsControlMenuFirst(root);
  let cmCount = 0;
  for (const { container, textEl } of cmResults) {
    if (!found.has(container) && !Array.from(found.keys()).some(c => c.contains(container) || container.contains(c))) {
      found.set(container, { source: 'control-menu', textEl });
      cmCount++;
    }
  }
  if (cmCount > 0) dlog(`Control-menu strategy found ${cmCount} additional post(s)`);

  // Strategy 3 (fallback): legacy class/data-urn selectors. These return NOTHING on
  // the modern feed (data-urn dropped, classes obfuscated) yet cost 11 whole-document
  // querySelectorAll passes — a large slice of the per-scan cost, paid every ~800ms
  // during scroll. Only fall back to them when the durable strategies found nothing
  // (old buckets / cached pages), so the hot path no longer pays for dead selectors.
  if (found.size === 0) {
    findPostsLegacySelectors(root, found);
    if (found.size > 0) dlog(`Legacy selector strategy found ${found.size} post(s)`);
  }

  // Deduplicate nested containers — keep the outermost match.
  const elements = Array.from(found.keys());
  const nested = new Set();
  for (let i = 0; i < elements.length; i++) {
    for (let j = 0; j < elements.length; j++) {
      if (i !== j && elements[i].contains(elements[j])) {
        nested.add(elements[j]);
      }
    }
  }
  if (nested.size > 0) {
    dlog(`Removed ${nested.size} nested duplicate(s)`);
    nested.forEach(el => found.delete(el));
  }

  return Array.from(found.entries()).map(([container, meta]) => ({
    container,
    textEl: meta.textEl,
  }));
}

function extractPostText(container) {
  // Strategy 1: Legacy selectors (still work on some pages / older buckets).
  for (const selector of SELECTORS.postText) {
    try {
      const el = container.querySelector(selector);
      if (el) {
        const text = el.innerText.trim();
        if (text.length > 0) return text;
      }
    } catch (e) {
      console.warn(LOG_PREFIX, 'Text selector failed:', selector, e);
    }
  }

  // Strategy 2: Largest <p> inside the container that isn't a notification line.
  // LinkedIn's new (obfuscated-class) feed renders post body as <p> tags.
  const paragraphs = Array.from(container.querySelectorAll('p'));
  let best = null;
  let bestLen = 0;
  for (const p of paragraphs) {
    const text = (p.innerText || '').trim();
    if (text.length < 20) continue;
    if (text.length < NON_BODY_MAX_LEN && NON_BODY_TEXT_PATTERNS.some(re => re.test(text))) continue;
    if (text.length > bestLen) {
      best = text;
      bestLen = text.length;
    }
  }
  return best;
}

// ─── SEE-MORE EXPANSION ───

const SEE_MORE_SELECTORS = [
  'button.feed-shared-inline-show-more-text',
  'a.feed-shared-inline-show-more-text',
  'button[class*="see-more"]',
  'a[class*="see-more"]',
];

// Matches the visible "see-more" trigger inside a post. LinkedIn renders this
// as "… more" or just "more" with the ellipsis sometimes outside the button.
// Leading ellipsis is therefore optional.
const SEE_MORE_TEXT_RE = /^(?:…|\.{3})?\s*more\s*$|^see more$/i;

function findSeeMoreButton(container) {
  // Try inside the container first
  for (const selector of SEE_MORE_SELECTORS) {
    const btn = container.querySelector(selector);
    if (btn) return btn;
  }
  let clickables = container.querySelectorAll('button, a, [role="button"]');
  for (const el of clickables) {
    const txt = (el.innerText || '').trim();
    if (SEE_MORE_TEXT_RE.test(txt)) return el;
  }
  // Sometimes the see-more button is a sibling of the container, not inside it.
  // Try the parent's subtree (excluding nodes already inside the container).
  const parent = container.parentElement;
  if (parent) {
    clickables = parent.querySelectorAll('button, a, [role="button"]');
    for (const el of clickables) {
      if (container.contains(el)) continue;
      const txt = (el.innerText || '').trim();
      if (SEE_MORE_TEXT_RE.test(txt)) return el;
    }
  }
  return null;
}

// Identify elements within textEl's neighborhood that are responsible for
// truncating the visible post body. As of late 2026, LinkedIn wraps the
// text in a <span> with `display: flow-root; height: 60px; overflow: hidden;
// -webkit-line-clamp: 3`, *inside* the <p>. So the clamp is below textEl,
// not above. We scan three places:
//   1. textEl itself
//   2. textEl's descendants (down 3 levels)
//   3. textEl's ancestors (up 3 levels)
// Returns the array of "clipping" elements that we should mutate to expand.
function findClippingElements(textEl) {
  if (!textEl) return [];
  const out = [];
  function checkOne(el) {
    if (!el || el.nodeType !== 1) return;
    try {
      // Clipped via overflow:hidden + content larger than the box.
      if (el.scrollHeight > el.clientHeight + 5) {
        const s = getComputedStyle(el);
        if (s.overflow === 'hidden' || s.overflowY === 'hidden') { out.push(el); return; }
      }
      // Clipped via -webkit-line-clamp.
      const s = getComputedStyle(el);
      if (s.webkitLineClamp && s.webkitLineClamp !== 'none' && s.webkitLineClamp !== '0') { out.push(el); return; }
    } catch (_) {}
  }
  // 1. textEl itself
  checkOne(textEl);
  // 2. descendants: BFS down 3 levels
  let frontier = [textEl];
  for (let d = 0; d < 3; d++) {
    const next = [];
    for (const el of frontier) {
      for (const c of el.children) { checkOne(c); next.push(c); }
    }
    frontier = next;
  }
  // 3. ancestors: up 3 levels
  let parent = textEl.parentElement;
  for (let i = 0; i < 3 && parent; i++) { checkOne(parent); parent = parent.parentElement; }
  return out;
}

// Returns true if text or its rendered element looks truncated. We check
// three signals in order:
//   (a) the text ends with an ellipsis sentinel
//   (b) any descendant/ancestor of textEl has a clipping CSS rule
function looksTruncated(text, textEl) {
  if (text) {
    const tail = text.trim().slice(-20);
    if (/(?:…|\.{3})\s*more\s*$/i.test(tail) || /…\s*$/.test(tail)) return true;
  }
  if (textEl && findClippingElements(textEl).length > 0) return true;
  return false;
}

// Strip the CSS that hides the rest of a clamped post body. We mutate
// every element identified by findClippingElements — which covers the
// current LinkedIn pattern (clamp on a child <span>) as well as older
// patterns (clamp on a parent wrapper).
//
// Reads and writes are batched: read getComputedStyle for all targets
// first, then apply all writes. This avoids layout thrashing.
function expandViaCss(textEl) {
  if (!textEl) return;
  const targets = findClippingElements(textEl);
  if (targets.length === 0) return;
  // Pass 1: read layout-dependent values
  const displays = [];
  for (const el of targets) {
    try { displays.push(getComputedStyle(el).display); }
    catch (_) { displays.push(''); }
  }
  // Pass 2: apply writes
  for (let i = 0; i < targets.length; i++) {
    const el = targets[i];
    try {
      el.style.maxHeight = 'none';
      el.style.height = 'auto';
      el.style.overflow = 'visible';
      el.style.webkitLineClamp = 'unset';
      // -webkit-box and flow-root with explicit height both need display
      // tweaks; flow-root is the current LinkedIn pattern.
      if (displays[i] === '-webkit-box' || displays[i] === 'flow-root') el.style.display = 'block';
    } catch (_) {}
  }
}

// Dispatch a full pointer + mouse + click sequence. LinkedIn's see-more
// handler attaches to pointerdown in some buckets, so a plain .click()
// silently no-ops.
function simulateClick(el) {
  try {
    const rect = el.getBoundingClientRect();
    const opts = {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    };
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.click();
  } catch (_) {
    try { el.click(); } catch (_) {}
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// LinkedIn scrolls inside <main id="workspace">, not the window. To restore
// scroll after a see-more click, find the closest scrollable ancestor.
function findScrollAncestor(el) {
  let cur = el && el.parentElement;
  while (cur && cur !== document.body) {
    const overflowY = getComputedStyle(cur).overflowY;
    if ((overflowY === 'auto' || overflowY === 'scroll') && cur.scrollHeight > cur.clientHeight) {
      return cur;
    }
    cur = cur.parentElement;
  }
  return null;
}

// ─── PROCESSING ───

// Pull the latest text for a post, preferring the known text element when
// the content-first strategy supplied one. Defensive: never throws — when
// LinkedIn's virtual scroll detaches a post between scheduling and reading,
// container or textEl can become null or a stale reference. Returning null
// in those cases lets the caller fall back safely.
function readPostText(container, textEl) {
  try {
    if (textEl && document.contains(textEl)) {
      const t = (textEl.innerText || '').trim();
      if (t.length > 0) return t;
    }
    if (!container || typeof container.querySelector !== 'function') return null;
    return extractPostText(container);
  } catch (_) {
    return null;
  }
}

async function processPost(post) {
  // Accept either bare container (legacy callers) or { container, textEl }.
  let container, textEl;
  if (post && post.nodeType === 1) {
    container = post;
    textEl = null;
  } else if (post && post.container) {
    container = post.container;
    textEl = post.textEl || null;
  } else {
    return;
  }

  _counters.processPostEntered++;
  const _tp = DEBUG ? performance.now() : 0; // full synchronous processPost cost

  if (container.hasAttribute(PROCESSED_ATTR)) { _counters.bailMarked++; return; }
  if (!extensionSettings.enabled || extensionSettings.displayMode === 'off') { _counters.bailDisabled++; return; }

  // Check for text early — LinkedIn may have added the container to the DOM
  // but not yet populated it with text content. If there's no text yet, bail
  // without marking so future scans can retry.
  const _tr = DEBUG ? performance.now() : 0;
  const earlyText = readPostText(container, textEl);
  if (DEBUG) _perfAdd('readtext', performance.now() - _tr); // innerText = forced reflow
  if (!earlyText) { _counters.bailNoText++; return; }

  // ── Badge-first: render immediately from the synchronous heuristic on
  // whatever text we have, BEFORE any expansion. Expansion awaits a layout
  // frame plus see-more round-trips; gating the badge behind that was the
  // scroll-badging bug — on a fast scroll (or a background/unfocused tab where
  // requestAnimationFrame is suspended) the first post hung at expansion, its
  // badge never rendered, and because the serial queue awaits processPost the
  // whole queue stalled so no later post badged either. The badge now renders
  // and marks the post processed up front (queue drains fast); expansion + ML
  // run off the badge path on their own serial queue and UPGRADE the badge.
  const wasTruncated = looksTruncated(earlyText, textEl);
  const badged = renderHeuristicBadge(container, earlyText, wasTruncated);
  if (!badged) { _counters.bailRenderFail++; return; } // leave PROCESSED_ATTR off so the next scan retries

  if (DEBUG) _perfAdd('process', performance.now() - _tp);

  // Auto-expansion DISABLED — it is the scroll-roughness, confirmed by an
  // extension on/off A/B on the live feed (OFF = smooth). expandAndUpgrade clicks
  // each post's "see more" (which forces a heavy LinkedIn re-render) and writes
  // scrollTop to compensate for the height change (which nudges the user's scroll
  // position). Both fight the scroll. We skip it: the badge already scored on the
  // visible text, and for CSS line-clamped posts that's the FULL text anyway (the
  // clamp only hides it visually — innerText still returns all of it), so the
  // score is unchanged: LinkedIn keeps the full post text in the DOM ("see more"
  // only changes what is shown, not what is there), so the text we already scored
  // is the whole post — verified on the live feed (truncated posts read full-length,
  // innerText == textContent). Flip to true to restore the old behavior.
  const EXPAND_ON_SCROLL = false;
  if (EXPAND_ON_SCROLL) enqueueExpansion({ container, textEl, baseText: earlyText, wasTruncated });
}

// Yield one frame so layout settles. requestAnimationFrame is SUSPENDED in
// background/unfocused tabs (e.g. when an automation driver holds the tab in
// the background, or the user tabs away mid-scroll), so race it against a
// setTimeout fallback — otherwise an off-screen expansion would hang forever
// and the badge would never upgrade to the full-text score.
function nextFrame() {
  return new Promise(resolve => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    requestAnimationFrame(done);
    setTimeout(done, 32);
  });
}

// Render the badge synchronously from the heuristic score and mark the post
// processed. Returns true iff the badge actually rendered, so the caller can
// leave the post UNMARKED for retry on failure. PROCESSED_ATTR is set ONLY
// after a successful render: a marked-but-unbadged wide ancestor would make
// findPostsContentFirst's `closest('[' + PROCESSED_ATTR + ']')` skip every
// post nested inside it — the original "scroll-stops-badging" failure mode.
function renderHeuristicBadge(container, text, wasTruncated) {
  if (typeof renderScoreBadge !== 'function') return false;

  // The badge is absolutely positioned, so the container must be a positioning
  // context. Use a class (cheap, batched into the next style flush) instead of
  // an inline style write (forces a synchronous style recalc).
  try {
    if (container && container.classList && !container.classList.contains('laid-container')) {
      container.classList.add('laid-container');
    }
  } catch (_) { /* container may be in a weird state — non-fatal */ }

  const normalizedText = text.normalize('NFKC');
  const preview = text.length > 60 ? text.substring(0, 57) + '...' : text;

  const _ts = DEBUG ? performance.now() : 0;
  const heuristicResult = typeof scorePostSync === 'function'
    ? scorePostSync(normalizedText)
    : null;
  if (DEBUG) _perfAdd('score', performance.now() - _ts);

  if (!heuristicResult) {
    console.warn(LOG_PREFIX, 'scorePostSync not available — using random score');
    try {
      renderScoreBadge(container, text, null);
      container.setAttribute(PROCESSED_ATTR, 'true');
      container.setAttribute(FINGERPRINT_ATTR, postFingerprint(container));
      _counters.badgeRendered++;
      return true;
    } catch (e) {
      console.warn(LOG_PREFIX, 'renderScoreBadge fallback failed:', e && e.message ? e.message : e);
      return false;
    }
  }

  const heuristicDisplay = {
    ...heuristicResult,
    partial: heuristicResult.partial || wasTruncated,
    mlScore: null, mlConfidence: null, mlLabel: null,
    heuristicScore: heuristicResult.score,
    mlAvailable: false, blendMode: 'heuristic-only'
  };

  dlog(`"${preview}" (${heuristicResult.wordCount}w): ${heuristicResult.score}/100 [Heuristic]`);
  const convergence = heuristicResult.convergenceBonus > 0 ? ` | Convergence: +${heuristicResult.convergenceBonus}` : '';
  const l = heuristicResult.layers;
  dlog(`  Vocab: ${l.vocabulary.score}/${l.vocabulary.max} | Structure: ${l.structure.score}/${l.structure.max} | Style: ${l.stylometry.score}/${l.stylometry.max} | LinkedIn: ${l.linkedin.score}/${l.linkedin.max}${convergence}`);

  try {
    const _tb = DEBUG ? performance.now() : 0;
    renderScoreBadge(container, text, heuristicDisplay);
    if (DEBUG) _perfAdd('badge', performance.now() - _tb); // badge DOM insertion cost
    container.setAttribute(PROCESSED_ATTR, 'true');
    container.setAttribute(FINGERPRINT_ATTR, postFingerprint(container));
    _counters.badgeRendered++;
  } catch (e) {
    console.warn(LOG_PREFIX, 'renderScoreBadge failed:', e && e.message ? e.message : e);
    return false;
  }
  try {
    chrome.runtime.sendMessage({ type: 'POST_SCORED', score: heuristicResult.score });
  } catch (e) { /* extension context may be invalidated */ }
  return true;
}

// Serial expansion queue — separate from the badge path. See-more clicks must
// stay serialized (concurrent clicks fight over LinkedIn's scrollIntoView and
// yank the feed), but they must NOT block badge rendering or the next post.
let expansionQueue = Promise.resolve();
function enqueueExpansion(job) {
  expansionQueue = expansionQueue
    .then(() => expandAndUpgrade(job))
    .catch(err => console.warn(LOG_PREFIX, 'expansion queue error:', err));
  return expansionQueue;
}

// Expand a truncated post (the badge is already rendered on the truncated
// text), then re-score the fuller text and upgrade the badge in place, then
// blend in the async ML score. Best-effort throughout: the badge already
// exists, so any failure here just leaves it at the heuristic/partial score.
async function expandAndUpgrade({ container, textEl, baseText, wasTruncated }) {
  if (!container || !document.contains(container)) return;

  // Don't expand under an actively-scrolling user. See-more clicks, line-clamp
  // removal and scrollTop compensation all shift layout and fight the scroll —
  // the single most jarring source of scroll glitches. Park until the feed
  // settles; the badge already rendered, so nothing the user sees waits on this.
  await waitForScrollIdle();
  if (!document.contains(container)) return;

  // Expansion: first try CSS surgery (no click, no scroll jump). Only if that
  // fails (LinkedIn lazy-loads the rest of the body via JS) do we click the
  // see-more button. The whole loop is wrapped in try/catch so an expansion
  // failure (detached container mid-await, simulateClick re-render breaking our
  // refs) never disturbs the badge that already rendered.
  try {
    let expansionAttempts = 0;
    while (expansionAttempts < 2) {
      const currentText = expansionAttempts === 0 ? baseText : readPostText(container, textEl);
      if (!currentText || !looksTruncated(currentText, textEl)) break;
      const beforeWords = currentText.split(/\s+/).length;

      // Step 1: try CSS surgery. Compensate scroll because expanding a post
      // above the viewport pushes everything below it down (the user sees their
      // scroll position jump). Snapshot heights before the writes, write, then
      // next frame measure the delta and add it to the scroll position.
      if (textEl && document.contains(textEl)) {
        const _te1 = DEBUG ? performance.now() : 0;
        const scrollEl = findScrollAncestor(container);
        const beforeRect = container.getBoundingClientRect();
        const containerWasAbove = beforeRect.bottom < 0;
        const beforeHeight = beforeRect.height;
        const scrollAnchor = scrollEl ? scrollEl.scrollTop : window.scrollY;

        expandViaCss(textEl);
        if (DEBUG) _perfAdd('expand', performance.now() - _te1); // pre-yield: rect read + line-clamp removal

        await nextFrame(); // settle layout (rAF, with setTimeout fallback for bg tabs)

        // Container may have been detached during the yield — abort gracefully
        // (the badge already rendered on the text we had).
        if (!document.contains(container)) break;

        const _te2 = DEBUG ? performance.now() : 0; // post-yield: rect read + scrollTop write + innerText = thrash
        const afterRect = container.getBoundingClientRect();
        const delta = afterRect.height - beforeHeight;
        // Skip compensation if the user started scrolling during the yield —
        // writing scrollTop now would fight their live scroll. Leaving it
        // uncompensated only shifts content they're already scrolling past.
        if (containerWasAbove && delta > 1 && !isUserScrolling()) {
          if (scrollEl) scrollEl.scrollTop = scrollAnchor + delta;
          else window.scrollTo({ top: scrollAnchor + delta, behavior: 'instant' });
        }

        const afterCss = readPostText(container, textEl);
        const afterCssWords = afterCss ? afterCss.split(/\s+/).length : 0;
        const stillTruncated = looksTruncated(afterCss, textEl);
        if (DEBUG) _perfAdd('expand', performance.now() - _te2);
        if (afterCssWords > beforeWords && !stillTruncated) {
          dlog(`Expanded via CSS (was ~${beforeWords} words, now ${afterCssWords} words, delta ${delta}px)`);
          const orphan = findSeeMoreButton(container);
          if (orphan) scheduleWrite(() => { try { orphan.style.display = 'none'; } catch (_) {} });
          break;
        }
      }

      // Step 2: CSS surgery didn't bring in more text — click see-more.
      // Snapshot + restore scroll because LinkedIn's handler calls scrollIntoView.
      const seeMoreBtn = findSeeMoreButton(container);
      if (!seeMoreBtn) break;
      const scrollEl = findScrollAncestor(container);
      const scrollAnchor = scrollEl ? scrollEl.scrollTop : window.scrollY;
      const beforeClickText = readPostText(container, textEl);
      const _tc = DEBUG ? performance.now() : 0;
      simulateClick(seeMoreBtn);
      if (DEBUG) _perfAdd('click', performance.now() - _tc); // LinkedIn's SYNCHRONOUS see-more re-render
      // Mid-check at 60ms: if LinkedIn already swapped the text in, skip the rest.
      await sleep(60);
      if (!document.contains(container)) break;

      let afterText = readPostText(container, textEl);
      if (afterText === beforeClickText) {
        await sleep(80); // total ~140ms
        if (!document.contains(container)) break;
        afterText = readPostText(container, textEl);
      }
      const after = scrollEl ? scrollEl.scrollTop : window.scrollY;
      // Same guard as the CSS path: if the user is mid-scroll, don't restore
      // scrollTop — LinkedIn's scrollIntoView jump is the lesser evil vs.
      // fighting their live scroll.
      if (Math.abs(after - scrollAnchor) > 30 && !isUserScrolling()) {
        if (scrollEl) scrollEl.scrollTop = scrollAnchor;
        else window.scrollTo({ top: scrollAnchor, behavior: 'instant' });
      }
      const afterWords = afterText ? afterText.split(/\s+/).length : 0;
      if (afterWords > beforeWords) {
        dlog(`Expanded truncated post (was ~${beforeWords} words, now ${afterWords} words)`);
        break;
      }
      expansionAttempts++;
    }
  } catch (err) {
    console.warn(LOG_PREFIX, 'Expansion failed; keeping badge on available text:', err && err.message ? err.message : err);
  }

  if (!document.contains(container)) return;
  const text = readPostText(container, textEl);
  if (!text) return;

  const stillTruncated = looksTruncated(text, textEl);
  const normalizedText = text.normalize('NFKC');
  const preview = text.length > 60 ? text.substring(0, 57) + '...' : text;

  // Upgrade the heuristic badge if expansion actually brought in more text
  // (the badge was scored on the truncated version).
  let heuristicResult = null;
  if (text !== baseText && typeof scorePostSync === 'function') {
    const _trs = DEBUG ? performance.now() : 0;
    heuristicResult = scorePostSync(normalizedText);
    if (DEBUG) _perfAdd('rescore', performance.now() - _trs); // full-text heuristic re-score
    if (heuristicResult && typeof updateScoreBadge === 'function') {
      updateScoreBadge(container, {
        ...heuristicResult,
        partial: heuristicResult.partial || stillTruncated,
        mlScore: null, mlConfidence: null, mlLabel: null,
        heuristicScore: heuristicResult.score,
        mlAvailable: false, blendMode: 'heuristic-only'
      });
    }
  }

  // Keep the recycle fingerprint in sync with the now-expanded body so the next
  // scan can't mistake this post for a recycled node. textContent is clamp-
  // invariant so this is usually a no-op, but a see-more click can swap the body
  // element, and we want the fingerprint to track the live content.
  try { if (container.hasAttribute(PROCESSED_ATTR)) container.setAttribute(FINGERPRINT_ATTR, postFingerprint(container)); } catch (_) {}

  // ── Async ML update (Noisy-OR blend), non-blocking and non-fatal. ──
  if (typeof scorePostWithML === 'function') {
    if (!heuristicResult && typeof scorePostSync === 'function') {
      const _trs2 = DEBUG ? performance.now() : 0;
      heuristicResult = scorePostSync(normalizedText);
      if (DEBUG) _perfAdd('rescore', performance.now() - _trs2);
    }
    try {
      const fullResult = await scorePostWithML(normalizedText, heuristicResult);
      if (fullResult.mlAvailable) {
        dlog(`"${preview}": ML update → ${fullResult.score}/100 [ML + Heuristic (Noisy-OR)]`);
        dlog(`  ML: ${fullResult.mlScore}/100 (${fullResult.mlLabel}, ${fullResult.mlConfidence.toFixed(2)} confidence) | Heuristic: ${fullResult.heuristicScore}/100 | Blended: ${fullResult.score}/100`);
        if (typeof updateScoreBadge === 'function') {
          updateScoreBadge(container, { ...fullResult, partial: fullResult.partial || stillTruncated });
        }
        try {
          chrome.runtime.sendMessage({ type: 'POST_SCORED', score: fullResult.score });
        } catch (e) { /* extension context may be invalidated */ }
      }
    } catch (err) {
      console.warn(LOG_PREFIX, 'ML scoring failed:', err);
    }
  }
}

// Single processing queue — every processPost call goes through here, so
// see-more clicks never overlap. Concurrent clicks were the root cause of
// the feed scroll-jump (LinkedIn's expansion handler calls scrollIntoView,
// and parallel clicks made the last-clicked post's scrollIntoView win).
let processingQueue = Promise.resolve();
function enqueueProcessPost(post) {
  processingQueue = processingQueue
    .then(() => processPost(post))
    .catch(err => console.warn(LOG_PREFIX, 'queue error:', err));
  return processingQueue;
}

// IntersectionObserver to defer scoring of posts that aren't in the viewport.
// LinkedIn loads ~10 posts at first paint; many are below the fold. Without
// deferral we'd click see-more on off-screen posts at page load — those
// clicks cascade scrollIntoView calls and yank the user to the bottom of
// the feed.
// We need to remember the textEl per pending post; WeakSet doesn't carry data,
// so use a WeakMap (container -> { container, textEl }).
const pendingPosts = new WeakMap();

// Posts that just entered the pre-fetch zone, waiting to be enqueued.
// We collect them and flush during the next browser-idle slice so scoring
// doesn't fight with scroll rendering. Without this, several posts entering
// the zone during one scroll gesture would each call enqueueProcessPost
// synchronously inside the IntersectionObserver callback, blocking the
// frame the browser needs for paint.
let _ioBatch = [];
let _ioScheduled = false;
function flushIoBatch(deadline) {
  _ioScheduled = false;
  const batch = _ioBatch;
  _ioBatch = [];
  // Time-slice the burst. These posts were deferred because they were below the
  // fold; when the user scrolls them into the 200px pre-fetch zone the IO fires
  // a whole batch at once. Draining them all here ran every processPost
  // back-to-back in ONE idle task — requestIdleCallback schedules WHEN there is
  // idle time but does NOT bound HOW LONG the callback runs, so a ~10-post batch
  // was a single ~260ms main-thread task that blocked the next several scroll
  // frames (the measured worstFrame=133ms jank). Process within a sub-frame
  // budget instead and re-schedule the remainder; the browser paints between
  // slices, so scrolling stays smooth while badges fill in progressively.
  // processPost is run DIRECTLY (not via the serial processingQueue) so its
  // synchronous badge cost counts against the budget here — chaining onto the
  // queue would defer that cost into a post-return microtask drain the budget
  // check can't see, which would defeat the slicing. processPost is idempotent
  // (PROCESSED_ATTR guard) so a re-queued remainder can't double-badge.
  const SLICE_BUDGET_MS = 8; // ~half a 16ms frame; leaves the rest for scroll paint
  const start = performance.now();
  let i = 0;
  for (; i < batch.length; i++) {
    processPost(batch[i]).catch(() => {}); // badge work is synchronous; expansion is fire-and-forget
    if (performance.now() - start >= SLICE_BUDGET_MS) { i++; break; }
  }
  if (i < batch.length) {
    // Yield: put the unprocessed remainder back at the front and let the browser
    // paint a scroll frame before the next slice.
    _ioBatch = batch.slice(i).concat(_ioBatch);
  }
  if (_ioBatch.length > 0) scheduleIoFlush();
}
function scheduleIoFlush() {
  if (_ioScheduled) return;
  _ioScheduled = true;
  _ric(flushIoBatch, { timeout: 500 });
}

const viewportObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (entry.isIntersecting && pendingPosts.has(entry.target)) {
      const post = pendingPosts.get(entry.target);
      pendingPosts.delete(entry.target);
      viewportObserver.unobserve(entry.target);
      _counters.ioFired++;
      _ioBatch.push(post);
    }
  }
  if (_ioBatch.length > 0) scheduleIoFlush();
}, { rootMargin: '200px 0px' }); // 200px below viewport: pre-score just-below-fold

async function processAllPosts(scopeRoot) {
  const _t0 = DEBUG ? performance.now() : 0;
  const posts = findPostContainers(scopeRoot);
  // Opt-in comment badging — comments only exist once a thread is expanded, so this
  // is a no-op (empty query) most of the time. They flow through the same pipeline.
  if (extensionSettings.badgeComments) {
    try {
      const croot = scopeRoot && scopeRoot.querySelectorAll ? scopeRoot : document;
      for (const c of findCommentContainers(croot)) posts.push(c);
    } catch (_) {}
  }
  const _scanMs = DEBUG ? performance.now() - _t0 : 0;
  if (DEBUG) _perfAdd('scan', _scanMs);
  _counters.scans++;
  _counters.postsFound += posts.length;
  if (posts.length === 0) { dumpCounters('empty'); return; }
  dlog(`Found ${posts.length} new post(s)`);

  // Deterministic offline harness: skip the viewport split (IntersectionObserver
  // timing is non-deterministic on a static file:// fixture) and route every
  // post straight to the serial queue.
  const testMode = typeof window !== 'undefined' && window.__laid_test;

  for (const post of posts) {
    const rect = post.container.getBoundingClientRect();
    const inView = rect.bottom > -200 && rect.top < window.innerHeight + 200;
    if (testMode || inView) {
      _counters.enqueuedDirect++;
      enqueueProcessPost(post);
    } else {
      _counters.deferredToIO++;
      pendingPosts.set(post.container, post);
      viewportObserver.observe(post.container);
    }
  }
  dumpCounters('scan');

  // DOM-growth probe (DEBUG only): the live foreground test reads these off the
  // <html data-laid-growth> beacon to confirm that DOM node count, scan-candidate
  // count, and scan time PLATEAU as the user scrolls a long feed — i.e. the scan
  // no longer ramps with scroll distance (the Cause-A symptom). All cheap reads,
  // gated behind DEBUG so production stays silent.
  if (DEBUG) {
    try {
      const domNodes = document.getElementsByTagName('*').length;
      const candidates = document.querySelectorAll('p, span.break-words, div[dir="ltr"]').length;
      const badges = document.querySelectorAll('.laid-score-badge').length;
      const msg = `GROWTH nodes=${domNodes} candidates=${candidates} badges=${badges} found=${posts.length} scan=${_scanMs.toFixed(1)}ms`;
      dlog(msg);
      document.documentElement.setAttribute('data-laid-growth', msg);
    } catch (_) { /* torn-down document — non-fatal */ }
  }

  // Harness awaits both serial queues so a caller can assert
  // (#badges === #posts) once every post has been badged (processingQueue) and
  // its expansion + ML upgrade has settled (expansionQueue).
  if (testMode) { await processingQueue; await expansionQueue; }
}

// ─── UTILITIES ───

function debounce(fn, ms) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), ms);
  };
}

// Debounce with a hard ceiling — if the trailing timer keeps getting reset
// (LinkedIn fires childList mutations with addedNodes continuously for
// reaction-count animations, lazy-loaded media, and the feed-tail loader),
// we still guarantee a scan within `maxWait` ms of the first call. Without
// this, the scan can be starved indefinitely on an active feed.
function debounceWithMaxWait(fn, ms, maxWait) {
  let timer = null;
  let firstCallAt = 0;
  let maxTimer = null;
  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (maxTimer) { clearTimeout(maxTimer); maxTimer = null; }
    firstCallAt = 0;
    fn();
  }
  return function () {
    const now = Date.now();
    if (firstCallAt === 0) {
      firstCallAt = now;
      // Arm the ceiling — fires at most once per max-wait window.
      maxTimer = setTimeout(flush, maxWait);
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, ms);
  };
}

// Batched DOM-write scheduler. Multiple calls in one frame coalesce into a
// single rAF; queued writes run in one pass so the browser only repaints
// once. Use for any DOM mutation that's not strictly time-critical.
let _writeQueue = [];
let _writeScheduled = false;
function scheduleWrite(fn) {
  _writeQueue.push(fn);
  if (_writeScheduled) return;
  _writeScheduled = true;
  requestAnimationFrame(() => {
    const queue = _writeQueue;
    _writeQueue = [];
    _writeScheduled = false;
    for (const f of queue) {
      try { f(); } catch (e) { console.warn(LOG_PREFIX, 'write error:', e); }
    }
  });
}

// Idle scheduler — runs fn when the browser is idle (no scroll/paint in
// progress), or after a short timeout. Used for "would be nice to do soon
// but never urgent" work like processing newly-intersecting posts.
const _ric = typeof requestIdleCallback === 'function'
  ? (fn, opts) => requestIdleCallback(fn, opts)
  : (fn) => setTimeout(() => fn({ timeRemaining: () => 0, didTimeout: true }), 50);

// ─── SCROLL-AWARE SCHEDULING ───
// The scroll-badging fix added a scroll listener and a see-more expansion pass.
// Run naively they stole main-thread time *inside* scroll frames and made the
// feed stutter. The dominant cost turned out to be the scan itself: it ran a
// full-document pass (content-first + control-menu + 11 dead legacy selectors)
// every ~800ms over a feed whose weight grows with scroll, plus a per-candidate
// recycle fingerprint. That's been cut (legacy guard, memoized recycle check,
// length-first reject). Expansion still writes scrollTop. Two rules keep it smooth:
//   1. Never run a scan synchronously inside a scroll/paint frame — coalesce
//      scans and run them in browser idle time (requestIdleCallback).
//   2. Never mutate post layout or write scrollTop while the user is actively
//      scrolling — see-more expansion fights their scroll and yanks position.

// True while the user has scrolled within the last ~250ms. Updated by the
// capture-phase scroll listener below (catches the window AND LinkedIn's inner
// overflow-scroll container).
let _lastScrollAt = 0;
function isUserScrolling() {
  return Date.now() - _lastScrollAt < 250;
}

// Park an async task until scrolling settles (or a safety ceiling elapses), so
// layout-disrupting work (see-more clicks, line-clamp removal, scrollTop
// compensation) only runs when the feed is still. The badge has already
// rendered by the time anything calls this, so nothing the user sees waits on it.
async function waitForScrollIdle(maxWaitMs = 1500) {
  const start = Date.now();
  while (isUserScrolling() && Date.now() - start < maxWaitMs) {
    await sleep(120);
  }
}

// Coalesced, idle-scheduled full scan. The MutationObserver (lazy-load) and the
// scroll listener both funnel through here, so we never run two innerText-heavy
// scans in one frame, and the scan executes in requestIdleCallback time —
// between scroll frames, never blocking one. The timeout still guarantees the
// scan runs even on a pathologically busy page that never goes idle.
let _scanScheduled = false;
function scheduleScan() {
  if (_scanScheduled) return;
  _scanScheduled = true;
  _ric(() => {
    _scanScheduled = false;
    processAllPosts();
  }, { timeout: 1000 });
}

// Heuristic: is this added node worth re-scanning? LinkedIn fires a constant
// stream of mutations for tooltips, hover state, reaction-count updates,
// typing indicators, etc. We reject the obvious leaf-level UI churn but
// accept any structural element — LinkedIn often inserts an empty wrapper
// and then populates it with the real post content, so a strict size
// threshold here drops real posts.
function isProbablyPostSubtree(node) {
  if (!node || node.nodeType !== 1) return false;
  const tag = node.tagName;
  // Reject leaf-level UI churn — these can never be post insertions.
  if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' ||
      tag === 'SVG' || tag === 'svg' || tag === 'IMG' || tag === 'PATH' ||
      tag === 'BR' || tag === 'HR') return false;
  // Reject standalone interactive widgets (popovers, tooltips, menu items).
  if (tag === 'BUTTON' || tag === 'A' || tag === 'INPUT' || tag === 'SELECT' ||
      tag === 'TEXTAREA' || tag === 'LABEL' || tag === 'OPTION') return false;
  // Accept everything else. The actual cost of re-scanning an irrelevant
  // subtree is low: findPostsContentFirst on a no-text element returns
  // ~immediately because the `text.length < 50` filter rejects all candidates.
  return true;
}

// ─── OBSERVER ───

// A set of subtree roots added since the last scan. We used to scope
// content-first scans to these subtrees only, which kept DOM traversal
// cheap on long feeds — but it cost us correctness: LinkedIn assembles
// posts via many small subtree insertions, and no single dirty root
// ever contained a complete post (text + engagement bar), so content-
// first's 2+-anchor threshold rejected every scoped scan. The fix is
// to do a full-document scan whenever ANY mutation arrives. With our
// `debounceWithMaxWait(300, 800)` ceiling the full scan runs at most
// ~once per second, and findPostsContentFirst on a ~100-candidate
// document is sub-10ms — cheaper than wrong, definitely.
//
// We still track dirtyRoots so future strategies (e.g. only scanning
// subtrees that grew past some threshold) can use them — but the
// happy path is now: any mutation → full scan.
let dirtyRoots = new Set();
let dirtyFullScan = false;

function processDirtyRoots() {
  dirtyFullScan = false;
  dirtyRoots = new Set();
  // Idle-coalesced (was a synchronous `await processAllPosts()`): on a feed that
  // lazy-loads while the user scrolls, running the innerText-heavy scan inline
  // here dropped scroll frames. scheduleScan defers it to idle time.
  scheduleScan();
}

// Trailing debounce of 300ms, but force a scan within 800ms even if mutations
// keep arriving. The trailing window collapses bursts of mutations; the
// ceiling makes sure we still process posts on a perpetually-busy feed.
const debouncedProcess = debounceWithMaxWait(processDirtyRoots, DEBOUNCE_MS, 800);

const observer = new MutationObserver((mutations) => {
  const _t0 = DEBUG ? performance.now() : 0;
  let touched = false;
  for (const m of mutations) {
    if (m.type !== 'childList') continue;
    if (m.addedNodes.length === 0) continue;
    for (const node of m.addedNodes) {
      // Drop tooltips, badges, counters, hover-state churn — anything too
      // small to be a post insertion. This is the single biggest win for
      // MutationObserver overhead on a busy feed.
      if (!isProbablyPostSubtree(node)) continue;
      dirtyRoots.add(node);
      touched = true;
    }
  }
  if (touched) debouncedProcess();
  if (DEBUG) _perfAdd('observer', performance.now() - _t0, mutations.length);
});

// Find the narrowest stable ancestor of the feed. LinkedIn uses <main> as
// the feed root on every page type we care about. If we can't find it at
// init (script ran before main rendered), retry briefly then fall back to
// document.body. Watching <main> instead of <body> cuts mutation traffic
// by 5-10× because we ignore the nav rail, hover popovers, and chat dock.
function attachObserver() {
  const target = document.querySelector('main') ||
                 document.querySelector('[role="main"]') ||
                 document.body;
  observer.observe(target, { childList: true, subtree: true });
  const desc = `${target.tagName.toLowerCase()}${target.id ? '#' + target.id : ''}`;
  dlog(`MutationObserver attached to <${desc}>`);
  try { if (DEBUG) document.documentElement.setAttribute('data-laid-observer', desc); } catch (_) {}
  return target !== document.body;
}

if (!window.__laid_test && !attachObserver()) {
  // <main> wasn't there yet — retry once after a brief delay, then again
  // after layout settles. If both fail, we stay on document.body.
  let retries = 0;
  const retryAttach = () => {
    if (retries >= 3) return;
    retries++;
    const m = document.querySelector('main') || document.querySelector('[role="main"]');
    if (m) {
      observer.disconnect();
      observer.observe(m, { childList: true, subtree: true });
      dlog(`MutationObserver re-attached to <main> after ${retries} retr${retries === 1 ? 'y' : 'ies'}`);
    } else {
      setTimeout(retryAttach, 500);
    }
  };
  setTimeout(retryAttach, 200);
}

// ─── SCROLL SWEEP ───
// LinkedIn's feed scrolls inside an INNER container (e.g. <main id="workspace">
// with overflow-y:scroll), not the window, and its virtualization detaches /
// recycles off-screen post subtrees. Two things broke scroll-badging:
//   1. The page-load IntersectionObserver deferral uses the default root (the
//      window viewport). Posts scrolling within the inner container often never
//      trip it — and in a throttled/unfocused tab IO callbacks are suspended
//      outright (same frame-lifecycle throttling that suspends rAF), so a
//      deferred post can sit unbadged forever.
//   2. A post deferred at load can be detached before it ever intersects, so
//      its observer entry is dead and nothing re-enqueues it.
// A capture-phase scroll listener catches scrolls from ANY element (scroll
// events don't bubble, but they DO reach window in the capture phase) without
// hardcoding LinkedIn's ever-changing scroller. Each settle re-runs the full
// scan: newly-visible posts take the reliable DIRECT badge path and recycled
// ones get re-found. The scan is sub-10ms and already-badged posts are skipped
// via PROCESSED_ATTR, so re-running it on scroll is cheap. Trailing 150ms after
// scroll stops, with a 500ms ceiling so badges also appear DURING a long scroll.
if (!window.__laid_test) {
  // Trailing-only: schedule a coalesced idle scan ~180ms AFTER the user pauses.
  // The previous version used a 500ms ceiling that fired the scan *during* a
  // continuous scroll — that synchronous innerText-heavy pass inside scroll
  // frames was the jank. We drop the ceiling: posts lazy-loaded mid-scroll are
  // still caught by the MutationObserver path, and this sweep's unique job
  // (re-finding recycled/deferred posts the IntersectionObserver missed) can
  // wait the ~180ms until the scroll settles — below the threshold of notice,
  // since the user isn't reading posts they're flinging past.
  let _scrollSweepTimer = null;
  const onScroll = () => {
    _lastScrollAt = Date.now(); // feeds isUserScrolling() (gates expansion)
    startFrameMonitor(); // debug-gated: profile frame drops for this gesture
    if (!extensionSettings.enabled || extensionSettings.displayMode === 'off') return;
    if (_scrollSweepTimer) clearTimeout(_scrollSweepTimer);
    _scrollSweepTimer = setTimeout(() => { _scrollSweepTimer = null; scheduleScan(); }, 180);
  };
  // Capture phase: scroll events don't bubble, but they DO reach window during
  // capture, so this catches LinkedIn's inner overflow scroller too. passive so
  // the listener can never delay the scroll itself.
  window.addEventListener('scroll', onScroll, { capture: true, passive: true });
}

// ─── SPA NAVIGATION DETECTION ───

let lastKnownUrl = window.location.href;

function detectPageType() {
  if (location.pathname.includes('/feed')) return 'feed';
  if (location.pathname.match(/\/in\/[^/]+\/recent-activity/)) return 'profile-activity';
  if (location.pathname.match(/\/in\/[^/]+\/detail\/recent-activity/)) return 'profile-activity';
  if (location.pathname.match(/\/in\/[^/]+/)) return 'profile';
  return 'other';
}

function onNavigationDetected(newUrl) {
  dlog(`Navigation detected: ${newUrl}`);
  dlog(`Page type: ${detectPageType()}`);

  // LinkedIn takes variable time to render new content after SPA navigation.
  // Retry several times over 3 seconds to catch posts as they appear.
  const retryDelays = [300, 700, 1200, 2000, 3000];
  retryDelays.forEach(delay => {
    setTimeout(() => {
      processAllPosts();
    }, delay);
  });
}

// 1. popstate — browser back/forward buttons
window.addEventListener('popstate', () => {
  const newUrl = window.location.href;
  if (newUrl !== lastKnownUrl) {
    lastKnownUrl = newUrl;
    onNavigationDetected(newUrl);
  }
});

// 2. Intercept pushState/replaceState — LinkedIn uses these for SPA navigation
let _interceptorsInstalled = false;
try {
  const originalPushState = history.pushState;
  history.pushState = function (...args) {
    originalPushState.apply(this, args);
    const newUrl = window.location.href;
    if (newUrl !== lastKnownUrl) {
      lastKnownUrl = newUrl;
      onNavigationDetected(newUrl);
    }
  };

  const originalReplaceState = history.replaceState;
  history.replaceState = function (...args) {
    originalReplaceState.apply(this, args);
    const newUrl = window.location.href;
    if (newUrl !== lastKnownUrl) {
      lastKnownUrl = newUrl;
      onNavigationDetected(newUrl);
    }
  };
  _interceptorsInstalled = true;
} catch (_) { /* sandboxed; fall through to polling */ }

// 3. Fallback polling — only needed if the pushState/replaceState
// interceptors failed to install (rare). When they did install, the
// interceptors + popstate cover every navigation method LinkedIn uses,
// so polling at any frequency just burns CPU. Even when we do poll, 2s
// is plenty — SPA navigation is a one-shot event the user initiates.
if (!_interceptorsInstalled) {
  setInterval(() => {
    const currentUrl = window.location.href;
    if (currentUrl !== lastKnownUrl) {
      lastKnownUrl = currentUrl;
      onNavigationDetected(currentUrl);
    }
  }, 2000);
}

// ─── TEST HOOK (offline harness only) ───
// content.js runs in an ISOLATED world on linkedin.com, so this assignment
// lands on the isolated-world window — invisible to the page and to MCP
// main-world eval, therefore inert in production. In test/harness.html
// content.js loads as a plain <script> (main world), so the harness reaches
// these handles on its own window and can drive the pipeline deterministically.
try {
  window.__laid = {
    processAllPosts,
    findPostContainers,
    findPostsContentFirst,
    getCounters: () => ({ ..._counters }),
    resetCounters: () => { for (const k in _counters) _counters[k] = 0; },
    resetQueue: () => { processingQueue = Promise.resolve(); _ioBatch = []; _ioScheduled = false; },
    dumpCounters,
  };
} catch (_) { /* window may be locked down in some contexts */ }

// ─── DEV RELOAD BRIDGE (DEBUG only) ───
// Lets the live-debug loop reload the unpacked extension from disk without
// touching chrome://extensions. A main-world driver posts
// window.postMessage('LAID_DEV_RELOAD','*'); the page and the content script
// share the same window message bus, so this isolated-world listener receives
// it and asks the background worker to chrome.runtime.reload(). Gated behind
// DEBUG so it never installs in production.
if (DEBUG) {
  window.addEventListener('message', (e) => {
    if (e.source === window && e.data === 'LAID_DEV_RELOAD') {
      console.log(LOG_PREFIX, 'DEV_RELOAD requested via postMessage bridge');
      try { chrome.runtime.sendMessage({ type: 'DEV_RELOAD' }); } catch (_) {}
    }
  });
}

// ─── INIT ───

const isIframe = window !== window.top;
console.log(LOG_PREFIX, `Content script loaded — page type: ${detectPageType()}, url: ${location.href}${isIframe ? ' (iframe)' : ''}`);
try { if (DEBUG) document.documentElement.setAttribute('data-laid-cs', isIframe ? 'iframe' : 'top'); } catch (_) {}
// Build marker — lets the dev loop CONFIRM which code is actually live after a
// reload (the unpacked dev-reload is finicky; a stale cache silently lies). Always
// set (not DEBUG-gated) and stamped with load time so a fresh inject is unmistakable.
try { document.documentElement.setAttribute('data-laid-build', 'r6-settings@' + Date.now()); } catch (_) {}

// Process posts already in the DOM. LinkedIn often lazy-loads the feed
// via XHR *after* document_idle, so the first scan can legitimately find
// zero posts; we retry over the next few seconds to catch them as they
// hydrate. Mirrors the SPA-navigation retry pattern (onNavigationDetected).
// MutationObserver should also catch these, but retries are a cheap
// belt-and-braces — full-doc scan with debounceWithMaxWait collapses
// duplicates automatically.
// Skipped under the offline harness (window.__laid_test), which drives
// processAllPosts() explicitly for deterministic assertions.
// ── BREAKAGE CANARY ──
// If LinkedIn changes the DOM out from under our selectors, detection silently
// returns nothing and badges quietly stop — the exact failure mode behind this whole
// saga. This watchdog notices "the page clearly has posts (control-menu buttons
// present) but we've badged none" across a few slow checks, then (a) flips to the
// resilient heuristic fallback so the user keeps getting badges, and (b) logs a loud
// warning so the maintainer knows to push an updated (remote) selector config. Cheap
// DOM counts on a 4s timer — never in the scroll path.
function canaryCheck() {
  try {
    if (_forceLegacy) return; // already on the fallback
    let markers = 0, badges = 0;
    try { markers = document.querySelectorAll(LAID_CONFIG.postMarker).length; } catch (_) {}
    try { badges = document.querySelectorAll('.laid-score-badge').length; } catch (_) {}
    if (badges > 0) { _canaryMisses = 0; return; }   // healthy — something is badged
    if (markers < 2) { _canaryMisses = 0; return; }  // no posts on screen — not a failure
    _canaryMisses++;
    if (_canaryMisses >= 3) {                          // ~12s of posts-present-but-0-badges
      _forceLegacy = true;
      console.warn(LOG_PREFIX, `DETECTION CANARY: ${markers} posts on screen but 0 badged ` +
        `across ${_canaryMisses} checks — LinkedIn's DOM likely changed. Falling back to ` +
        `heuristic detection; update the hosted selectors.json to restore fast detection.`);
      try { document.documentElement.setAttribute('data-laid-canary', 'tripped:' + markers); } catch (_) {}
      processAllPosts(); // immediate retry through the fallback so badges return now
    }
  } catch (_) {}
}

if (!window.__laid_test) {
  processAllPosts();
  const initialRetryDelays = [300, 700, 1500, 3000, 5000];
  initialRetryDelays.forEach(d => setTimeout(() => {
    try { processAllPosts(); }
    catch (e) { console.warn(LOG_PREFIX, 'initial-retry scan failed:', e); }
  }, d));
  // Watchdog: detect + auto-recover if LinkedIn breaks our selectors. Starts after
  // ~6s so initial hydration/badging isn't mistaken for breakage.
  setTimeout(() => setInterval(canaryCheck, 4000), 6000);
}
