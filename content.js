/**
 * LinkedIn AI Detector — Content Script
 * Finds LinkedIn posts in the DOM, extracts text, and triggers badge rendering.
 */

// ─── SELECTORS (update here when LinkedIn changes their DOM) ───

const SELECTORS = {
  postContainer: [
    'div.feed-shared-update-v2',
    'div[data-urn^="urn:li:activity"]',
    'div.feed-shared-update-v2[data-urn]',
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
  const found = new Set();
  for (const selector of SELECTORS.postContainer) {
    try {
      const elements = document.querySelectorAll(selector);
      elements.forEach((el) => {
        if (!el.hasAttribute(PROCESSED_ATTR)) {
          found.add(el);
        }
      });
    } catch (e) {
      console.warn(LOG_PREFIX, 'Selector failed:', selector, e);
    }
  }

  // Heuristic fallback: if primary selectors found nothing, look for
  // div elements that contain both a profile/avatar area and a text block.
  // This survives LinkedIn class name changes.
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
        if (el.hasAttribute(PROCESSED_ATTR)) return;
        const hasAvatar =
          el.querySelector('img.feed-shared-actor__avatar-image') ||
          el.querySelector('img[alt*="profile"]') ||
          el.querySelector('a[href*="/in/"] img');
        const hasText =
          el.querySelector('span.break-words') ||
          el.querySelector('div[dir="ltr"]');
        if (hasAvatar && hasText) {
          found.add(el);
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

  return Array.from(found);
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

  // Render badge (defined in ui/overlay.js)
  if (typeof renderScoreBadge === 'function') {
    renderScoreBadge(container, text);
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

// Process posts already in the DOM
processAllPosts();

console.log(LOG_PREFIX, 'Content script loaded');
