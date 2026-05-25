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

const PROCESSED_ATTR = 'data-ai-scored';
const DEBOUNCE_MS = 150;
const LOG_PREFIX = '[AI Detector]';

console.log(LOG_PREFIX, `content script loaded on ${location.href}`);

// ─── SETTINGS ───

let extensionSettings = { enabled: true, displayMode: 'badge' };

// Load settings from background on init
try {
  chrome.runtime.sendMessage({ type: 'GET_SETTINGS' }, (settings) => {
    if (settings) extensionSettings = settings;
  });
} catch (e) {
  // Extension context may be invalidated
}

// Listen for settings changes from popup/background
try {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'SETTINGS_CHANGED') {
      const prevMode = extensionSettings.displayMode;
      extensionSettings = msg.settings;
      console.log(LOG_PREFIX, 'Settings updated:', extensionSettings);
      if (!extensionSettings.enabled || extensionSettings.displayMode === 'off') {
        // Hide all existing badges
        document.querySelectorAll('.laid-score-badge').forEach(b => b.style.display = 'none');
      } else {
        // Show all badges
        document.querySelectorAll('.laid-score-badge').forEach(b => b.style.display = '');
      }
      // React to badge-expand toggle: open or close cards on existing badges
      if (extensionSettings.displayMode === 'badge-expand' && prevMode !== 'badge-expand') {
        document.querySelectorAll('.laid-score-badge').forEach(badge => {
          const result = badge._aiResult;
          if (!result || result.partial) return;
          const container = badge.parentElement;
          if (container && !container.querySelector('.laid-breakdown-card') &&
              typeof openBreakdownCard === 'function') {
            openBreakdownCard(container, badge, { dismissOthers: false, closeOnOutsideClick: false });
          }
        });
      } else if (prevMode === 'badge-expand' && extensionSettings.displayMode !== 'badge-expand') {
        document.querySelectorAll('.laid-breakdown-card').forEach(c => c.remove());
      }
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

function findPostContainers() {
  const found = new Map(); // element -> matched selector (for debug logging)

  // ── Strategy 1: Legacy class/data-urn selectors (still work on some pages) ──
  for (const selector of SELECTORS.postContainer) {
    try {
      const elements = document.querySelectorAll(selector);
      elements.forEach((el) => {
        if (!el.hasAttribute(PROCESSED_ATTR) && !found.has(el)) {
          if (!el.closest(`[${PROCESSED_ATTR}]`)) {
            found.set(el, selector);
          }
        }
      });
    } catch (e) {
      console.warn(LOG_PREFIX, 'Selector failed:', selector, e);
    }
  }

  // ── Strategy 2: Structural anchor (survives class obfuscation) ──
  // LinkedIn's "Open control menu for post by NAME" button is a stable
  // per-post anchor with a unique aria-label pattern. Walk up to find the
  // post container — the ancestor that holds both the menu button AND the
  // post-level Comment/Repost action buttons.
  const primaryCount = found.size;
  try {
    const anchors = document.querySelectorAll('button[aria-label^="Open control menu for post by"]');
    anchors.forEach((btn) => {
      let cur = btn;
      for (let i = 0; i < 12 && cur && cur !== document.body; i++) {
        if (cur.querySelector('button[aria-label*="Comment"]') &&
            cur.querySelector('button[aria-label*="Repost"]')) {
          if (!cur.hasAttribute(PROCESSED_ATTR) && !found.has(cur) &&
              !cur.closest(`[${PROCESSED_ATTR}]`)) {
            found.set(cur, 'aria-anchor (control menu)');
          }
          break;
        }
        cur = cur.parentElement;
      }
    });
    const newCount = found.size - primaryCount;
    if (newCount > 0) {
      console.log(LOG_PREFIX, `Aria-anchor strategy found ${newCount} post(s)`);
    }
  } catch (e) {
    console.warn(LOG_PREFIX, 'Aria-anchor strategy failed:', e);
  }

  // Deduplicate nested containers — if a matched element is a descendant
  // of another match, remove the inner one to prevent double badges.
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
    console.log(LOG_PREFIX, `Removed ${nested.size} nested duplicate(s)`);
    nested.forEach(el => found.delete(el));
  }

  return Array.from(found.keys());
}

// Patterns that identify a <p> as something other than post body text:
// "X and Y like this", "X reposted this", "Followed by X", etc.
const NON_BODY_TEXT_PATTERNS = [
  /\blikes? this\b/i,
  /\breposted (this|by)\b/i,
  /\bcommented on\b/i,
  /\bfollow(ed|s|ing)?\b/i,
  /^Promoted$/i,
  /^Suggested$/i,
];

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
    if (NON_BODY_TEXT_PATTERNS.some(re => re.test(text))) continue;
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

// Matches the visible "see-more" trigger inside a post. As of late 2026 LinkedIn
// renders this as a <button> with text "… more" (note the space) and fully
// obfuscated classes — no aria-label, no role, no stable attributes. So the
// only durable hook is the text content.
const SEE_MORE_TEXT_RE = /^(?:…|\.{3})\s*more$|^see more$/i;

function findSeeMoreButton(container) {
  for (const selector of SEE_MORE_SELECTORS) {
    const btn = container.querySelector(selector);
    if (btn) return btn;
  }
  const clickables = container.querySelectorAll('button, a, [role="button"]');
  for (const el of clickables) {
    const txt = (el.innerText || '').trim();
    if (SEE_MORE_TEXT_RE.test(txt)) return el;
  }
  return null;
}

// Returns true if text still looks truncated (LinkedIn appends "… more" inline,
// or the body literally ends with an ellipsis).
function looksTruncated(text) {
  if (!text) return false;
  const tail = text.trim().slice(-20);
  return /(?:…|\.{3})\s*more\s*$/i.test(tail) || /…\s*$/.test(tail);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── PROCESSING ───

async function processPost(container) {
  if (container.hasAttribute(PROCESSED_ATTR)) return;
  if (!extensionSettings.enabled || extensionSettings.displayMode === 'off') return;

  // Check for text BEFORE marking as processed — LinkedIn may have added the
  // container to the DOM but not yet populated it with text content.  If we
  // mark it now, later retries will skip it and the post never gets scored.
  const earlyText = extractPostText(container);
  if (!earlyText) return;

  // Mark as processed now that we know there's text to score
  container.setAttribute(PROCESSED_ATTR, 'true');

  // Expand truncated posts by clicking "see more". Retry once if the first
  // click didn't take effect (LinkedIn sometimes re-renders the body).
  let expansionAttempts = 0;
  while (expansionAttempts < 2) {
    const currentText = expansionAttempts === 0 ? earlyText : extractPostText(container);
    if (!currentText || !looksTruncated(currentText)) break;
    const seeMoreBtn = findSeeMoreButton(container);
    if (!seeMoreBtn) break;
    const beforeWords = currentText.split(/\s+/).length;
    seeMoreBtn.click();
    await sleep(150);
    const afterText = extractPostText(container);
    const afterWords = afterText ? afterText.split(/\s+/).length : 0;
    if (afterWords > beforeWords) {
      console.log(LOG_PREFIX, `Expanded truncated post (was ~${beforeWords} words, now ${afterWords} words)`);
      break;
    }
    expansionAttempts++;
  }

  const text = extractPostText(container);
  if (!text) return;

  // If the post still looks truncated, score the available text but flag the
  // result as partial so the badge tooltip is honest and auto-expand skips it.
  const wasTruncated = looksTruncated(text);
  if (wasTruncated) {
    console.warn(LOG_PREFIX, `Post still truncated after expansion attempt; scoring on partial text`);
  }

  // Ensure the container can anchor absolutely-positioned children
  const position = getComputedStyle(container).position;
  if (position === 'static') {
    container.style.position = 'relative';
  }

  const normalizedText = text.normalize('NFKC');
  const preview = text.length > 60 ? text.substring(0, 57) + '...' : text;

  // ── Phase 1: Instant heuristic scoring + badge ──
  const heuristicResult = typeof scorePostSync === 'function'
    ? scorePostSync(normalizedText)
    : null;

  if (heuristicResult) {
    const heuristicDisplay = {
      ...heuristicResult,
      partial: heuristicResult.partial || wasTruncated,
      mlScore: null, mlConfidence: null, mlLabel: null,
      heuristicScore: heuristicResult.score,
      mlAvailable: false, blendMode: 'heuristic-only'
    };

    // Log heuristic results
    console.log(LOG_PREFIX, `"${preview}" (${heuristicResult.wordCount}w): ${heuristicResult.score}/100 [Heuristic]`);
    const convergence = heuristicResult.convergenceBonus > 0 ? ` | Convergence: +${heuristicResult.convergenceBonus}` : '';
    const l = heuristicResult.layers;
    console.log(LOG_PREFIX, `  Vocab: ${l.vocabulary.score}/${l.vocabulary.max} | Structure: ${l.structure.score}/${l.structure.max} | Style: ${l.stylometry.score}/${l.stylometry.max} | LinkedIn: ${l.linkedin.score}/${l.linkedin.max}${convergence}`);

    // Render badge immediately with heuristic score
    if (typeof renderScoreBadge === 'function') {
      renderScoreBadge(container, text, heuristicDisplay, {
        autoExpand: extensionSettings.displayMode === 'badge-expand'
      });
      try {
        chrome.runtime.sendMessage({ type: 'POST_SCORED', score: heuristicResult.score });
      } catch (e) { /* extension context may be invalidated */ }
    }

    // ── Phase 2: Async ML update (non-blocking) ──
    if (typeof scorePostWithML === 'function') {
      scorePostWithML(normalizedText, heuristicResult).then(fullResult => {
        if (fullResult.mlAvailable) {
          console.log(LOG_PREFIX, `"${preview}": ML update → ${fullResult.score}/100 [ML + Heuristic (Noisy-OR)]`);
          console.log(LOG_PREFIX, `  ML: ${fullResult.mlScore}/100 (${fullResult.mlLabel}, ${fullResult.mlConfidence.toFixed(2)} confidence) | Heuristic: ${fullResult.heuristicScore}/100 | Blended: ${fullResult.score}/100`);

          if (typeof updateScoreBadge === 'function') {
            updateScoreBadge(container, { ...fullResult, partial: fullResult.partial || wasTruncated });
          }
          try {
            chrome.runtime.sendMessage({ type: 'POST_SCORED', score: fullResult.score });
          } catch (e) { /* extension context may be invalidated */ }
        }
      }).catch(err => {
        console.warn(LOG_PREFIX, 'ML scoring failed:', err);
      });
    }
  } else {
    console.warn(LOG_PREFIX, 'scorePostSync not available — using random score');
    if (typeof renderScoreBadge === 'function') {
      renderScoreBadge(container, text, null);
    }
  }
}

async function processAllPosts() {
  const posts = findPostContainers();
  if (posts.length > 0) {
    console.log(LOG_PREFIX, `Found ${posts.length} new post(s)`);
  }
  // Process all posts in parallel — each one renders its heuristic badge
  // immediately, ML updates trickle in as they complete.
  await Promise.all(posts.map(post => processPost(post)));
}

// ─── UTILITIES ───

function debounce(fn, ms) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), ms);
  };
}

// ─── OBSERVER ───

const debouncedProcess = debounce(processAllPosts, DEBOUNCE_MS);

const observer = new MutationObserver((mutations) => {
  // Process on any childList mutation with added nodes OR large subtree changes
  const dominated = mutations.some(
    (m) =>
      (m.type === 'childList' && m.addedNodes.length > 0) ||
      (m.type === 'childList' && m.removedNodes.length > 0)
  );
  if (dominated) {
    debouncedProcess();
  }
});

observer.observe(document.body, { childList: true, subtree: true });

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
  console.log(LOG_PREFIX, `Navigation detected: ${newUrl}`);
  console.log(LOG_PREFIX, `Page type: ${detectPageType()}`);

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

// 3. Fallback polling — catch any navigation method we missed
setInterval(() => {
  const currentUrl = window.location.href;
  if (currentUrl !== lastKnownUrl) {
    lastKnownUrl = currentUrl;
    onNavigationDetected(currentUrl);
  }
}, 500);

// ─── INIT ───

const isIframe = window !== window.top;
console.log(LOG_PREFIX, `Content script loaded — page type: ${detectPageType()}, url: ${location.href}${isIframe ? ' (iframe)' : ''}`);

// Process posts already in the DOM
processAllPosts();
