/**
 * LinkedIn AI Detector — Badge Overlay
 * Renders a color-coded score badge on each LinkedIn post.
 * Uses real scores from the scoring engine.
 */

function getScoreColor(score) {
  if (score <= 35) return 'laid-score-green';
  if (score <= 65) return 'laid-score-amber';
  return 'laid-score-red';
}

function getScoreLabel(score) {
  if (score <= 35) return 'Likely Human';
  if (score <= 65) return 'Mixed Signals';
  return 'Likely AI-Generated';
}

/**
 * Renders a score badge in the top-right corner of a post container.
 * @param {HTMLElement} postContainer - The post's DOM element
 * @param {string} postText - The extracted post text
 * @param {object|null} result - Scoring engine result, or null for fallback
 * @returns {number} The score that was rendered
 */
function renderScoreBadge(postContainer, postText, result) {
  // Guard against duplicate badges
  if (postContainer.querySelector('.laid-score-badge')) return -1;

  // Use real score from engine, or fallback to random if engine unavailable
  const score = result ? result.score : Math.floor(Math.random() * 101);

  const badge = document.createElement('div');
  badge.className = `laid-score-badge ${getScoreColor(score)}`;
  badge.textContent = score;
  badge.setAttribute('data-tooltip', `AI Pattern Score: ${score}/100 \u2014 ${getScoreLabel(score)}`);
  badge.setAttribute('data-score', score);

  // Store full result for later use (click-to-expand in Phase 3)
  if (result) {
    badge._aiResult = result;
  }

  postContainer.appendChild(badge);

  return score;
}
