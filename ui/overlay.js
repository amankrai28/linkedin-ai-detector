/**
 * LinkedIn AI Detector — Badge Overlay
 * Renders a color-coded score badge on each LinkedIn post.
 * Phase 1: Uses random scores for testing. Will be replaced by the scoring engine in Phase 2.
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
 * @param {string} postText - The extracted post text (unused in Phase 1)
 * @returns {number} The score that was rendered
 */
function renderScoreBadge(postContainer, postText) {
  // Guard against duplicate badges
  if (postContainer.querySelector('.laid-score-badge')) return -1;

  // Phase 1: random score for testing (replaced by scoring engine in Phase 2)
  const score = Math.floor(Math.random() * 101);

  const badge = document.createElement('div');
  badge.className = `laid-score-badge ${getScoreColor(score)}`;
  badge.textContent = score;
  badge.setAttribute('data-tooltip', `AI Pattern Score: ${score}/100 \u2014 ${getScoreLabel(score)}`);
  badge.setAttribute('data-score', score);

  postContainer.appendChild(badge);

  return score;
}
