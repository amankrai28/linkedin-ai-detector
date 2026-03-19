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
    // Activity URN-based selectors (works on both feed and profile pages)
    'div[data-urn^="urn:li:activity"]',
    'div[data-urn*="activity"]',
  ],
  postText: [
    'div.feed-shared-text',
    'span.break-words',
    'div.feed-shared-update-v2__description',
    'div.update-components-text',
  ],
};

const PROCESSED_ATTR = 'data-ai-scored';
const DEBOUNCE_MS = 150;
const LOG_PREFIX = '[AI Detector]';

// ─── DOM EXTRACTION ───

function findPostContainers() {
  const found = new Map(); // element -> matched selector (for debug logging)

  for (const selector of SELECTORS.postContainer) {
    try {
      const elements = document.querySelectorAll(selector);
      elements.forEach((el) => {
        if (!el.hasAttribute(PROCESSED_ATTR) && !found.has(el)) {
          found.set(el, selector);
        }
      });
    } catch (e) {
      console.warn(LOG_PREFIX, 'Selector failed:', selector, e);
    }
  }

  // Heuristic fallback: containers with both a text block and social
  // action buttons (like/comment/repost). Works on profile activity
  // pages where class names may differ from the main feed.
  if (found.size === 0) {
    console.warn(
      LOG_PREFIX,
      'Primary selectors matched 0 posts — trying heuristic fallback'
    );
    try {
      const candidates = document.querySelectorAll(
        'div[data-urn], div[data-id]'
      );
      candidates.forEach((el) => {
        if (el.hasAttribute(PROCESSED_ATTR) || found.has(el)) return;

        const hasText =
          el.querySelector('span.break-words') ||
          el.querySelector('div[dir="ltr"]');

        const hasSocialActions =
          el.querySelector('button[aria-label*="Like"]') ||
          el.querySelector('button[aria-label*="like"]') ||
          el.querySelector('button[aria-label*="Comment"]') ||
          el.querySelector('button[aria-label*="Repost"]') ||
          el.querySelector('.social-actions-button') ||
          el.querySelector('.feed-shared-social-action-bar') ||
          el.querySelector('.social-details-social-counts');

        const hasAvatar =
          el.querySelector('img.feed-shared-actor__avatar-image') ||
          el.querySelector('img[alt*="profile"]') ||
          el.querySelector('a[href*="/in/"] img');

        // Match if text + social actions, or text + avatar (original heuristic)
        if (hasText && (hasSocialActions || hasAvatar)) {
          found.set(el, 'heuristic-fallback (text + social/avatar)');
        }
      });
      if (found.size > 0) {
        console.log(
          LOG_PREFIX,
          `Heuristic fallback found ${found.size} post(s)`
        );
      }
    } catch (e) {
      console.warn(LOG_PREFIX, 'Heuristic fallback failed:', e);
    }
  }

  // Log which selector matched each container for debugging
  found.forEach((selector, el) => {
    const urn = el.getAttribute('data-urn') || '(no urn)';
    console.log(LOG_PREFIX, `Matched: "${selector}" — urn: ${urn}`);
  });

  return Array.from(found.keys());
}

function extractPostText(container) {
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
  return null;
}

// ─── PROCESSING ───

function processPost(container) {
  if (container.hasAttribute(PROCESSED_ATTR)) return;

  const text = extractPostText(container);
  if (!text) return;

  container.setAttribute(PROCESSED_ATTR, 'true');

  // Ensure the container can anchor absolutely-positioned children
  const position = getComputedStyle(container).position;
  if (position === 'static') {
    container.style.position = 'relative';
  }

  // Score the post text through the scoring engine
  let result = null;
  if (typeof scorePost === 'function') {
    result = scorePost(text);
    console.log(LOG_PREFIX, `Scored post (${result.wordCount} words): ${result.score}/100`, result.topSignals);
  } else {
    console.warn(LOG_PREFIX, 'scorePost not available — using random score');
  }

  // Render badge (defined in ui/overlay.js)
  if (typeof renderScoreBadge === 'function') {
    renderScoreBadge(container, text, result);
  } else {
    console.warn(LOG_PREFIX, 'renderScoreBadge not available');
  }
}

function processAllPosts() {
  const posts = findPostContainers();
  if (posts.length > 0) {
    console.log(LOG_PREFIX, `Found ${posts.length} new post(s)`);
  }
  posts.forEach(processPost);
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
  // Only process if new nodes were actually added
  const hasNewNodes = mutations.some(
    (m) => m.type === 'childList' && m.addedNodes.length > 0
  );
  if (hasNewNodes) {
    debouncedProcess();
  }
});

observer.observe(document.body, { childList: true, subtree: true });

// Detect page type for debugging
const pageType = location.pathname.includes('/feed')
  ? 'feed'
  : location.pathname.match(/\/in\/[^/]+\/recent-activity/)
    ? 'profile-activity'
    : location.pathname.match(/\/in\/[^/]+/)
      ? 'profile'
      : 'other';
console.log(LOG_PREFIX, `Content script loaded — page type: ${pageType}, url: ${location.pathname}`);

// Process posts already in the DOM
processAllPosts();
