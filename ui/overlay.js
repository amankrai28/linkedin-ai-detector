/**
 * LinkedIn AI Detector — Badge Overlay
 * Renders a color-coded score badge on each LinkedIn post.
 * Click to expand a detailed breakdown card.
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

function getScoreColorHex(score) {
  if (score <= 35) return '#2e7d32';
  if (score <= 65) return '#f57c00';
  return '#c62828';
}

/**
 * Creates a progress bar element for a scoring layer.
 */
function createLayerBar(name, score, max) {
  const pct = max > 0 ? Math.round((score / max) * 100) : 0;
  const row = document.createElement('div');
  row.className = 'laid-layer-row';

  row.innerHTML = `
    <span class="laid-layer-name">${name}</span>
    <div class="laid-layer-track">
      <div class="laid-layer-fill" style="width:${pct}%"></div>
    </div>
    <span class="laid-layer-score">${score}/${max}</span>
  `;
  return row;
}

/**
 * Creates the expanded breakdown card from a scoring result.
 */
function createBreakdownCard(result) {
  const card = document.createElement('div');
  card.className = 'laid-breakdown-card';

  const score = result.score;
  const label = getScoreLabel(score);
  const color = getScoreColorHex(score);

  // Header
  const header = document.createElement('div');
  header.className = 'laid-breakdown-header';
  header.innerHTML = `
    <span class="laid-breakdown-score" style="color:${color}">${score}</span>
    <span class="laid-breakdown-label">/100 — ${label}</span>
  `;
  card.appendChild(header);

  // Layer bars
  const layers = result.layers;
  const layerData = [
    ['Vocabulary', layers.vocabulary.score, layers.vocabulary.max],
    ['Structure', layers.structure.score, layers.structure.max],
    ['Stylometry', layers.stylometry.score, layers.stylometry.max],
    ['LinkedIn', layers.linkedin.score, layers.linkedin.max]
  ];

  const barsContainer = document.createElement('div');
  barsContainer.className = 'laid-breakdown-bars';
  for (const [name, s, m] of layerData) {
    barsContainer.appendChild(createLayerBar(name, s, m));
  }
  card.appendChild(barsContainer);

  // Top signals
  if (result.topSignals && result.topSignals.length > 0) {
    const signalsDiv = document.createElement('div');
    signalsDiv.className = 'laid-breakdown-signals';

    const signalsTitle = document.createElement('div');
    signalsTitle.className = 'laid-breakdown-signals-title';
    signalsTitle.textContent = 'Top signals:';
    signalsDiv.appendChild(signalsTitle);

    const ul = document.createElement('ul');
    for (const sig of result.topSignals) {
      const li = document.createElement('li');
      li.textContent = sig;
      ul.appendChild(li);
    }
    signalsDiv.appendChild(ul);
    card.appendChild(signalsDiv);
  }

  // Footer info
  const footer = document.createElement('div');
  footer.className = 'laid-breakdown-footer';
  const parts = [`${result.wordCount} words`];
  if (result.partial) parts.push('limited text');
  if (result.convergenceBonus > 0) parts.push(`+${result.convergenceBonus} convergence`);
  if (result.mlAvailable) {
    parts.push(`ML: ${result.mlScore}/100`);
    parts.push(`Heuristic: ${result.heuristicScore}/100`);
  } else if (result.blendMode === 'heuristic-only') {
    parts.push('ML model loading...');
  }
  footer.textContent = parts.join(' · ');
  card.appendChild(footer);

  return card;
}

/**
 * Removes any open breakdown card in the document.
 */
function dismissBreakdownCard() {
  const existing = document.querySelector('.laid-breakdown-card');
  if (existing) existing.remove();
}

/**
 * Updates an existing score badge with new results (e.g., after ML scoring completes).
 * @param {HTMLElement} postContainer - The post's DOM element
 * @param {object} result - Updated scoring engine result
 */
// eslint-disable-next-line no-unused-vars
function updateScoreBadge(postContainer, result) {
  const badge = postContainer.querySelector('.laid-score-badge');
  if (!badge) return;

  const score = result.score;
  badge.textContent = score;
  badge.className = `laid-score-badge ${getScoreColor(score)}`;
  badge.setAttribute('data-score', score);

  let tooltipSuffix = '';
  if (result.partial) {
    tooltipSuffix = ' (limited text)';
  } else if (result.blendMode === 'noisy-or') {
    tooltipSuffix = ' (ML + heuristic)';
  }
  badge.setAttribute('data-tooltip', `AI Pattern Score: ${score}/100${tooltipSuffix} — ${getScoreLabel(score)}`);
  badge._aiResult = result;
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
  let tooltipSuffix = '';
  if (result && result.partial) {
    tooltipSuffix = ' (limited text)';
  } else if (result && result.blendMode === 'heuristic-only') {
    tooltipSuffix = ' (loading ML model...)';
  } else if (result && result.blendMode === 'noisy-or') {
    tooltipSuffix = ' (ML + heuristic)';
  }
  badge.setAttribute('data-tooltip', `AI Pattern Score: ${score}/100${tooltipSuffix} — ${getScoreLabel(score)}`);
  badge.setAttribute('data-score', score);

  // Store full result for breakdown card
  if (result) {
    badge._aiResult = result;
  }

  // Click to toggle breakdown card
  badge.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();

    const existingCard = postContainer.querySelector('.laid-breakdown-card');
    if (existingCard) {
      existingCard.remove();
      return;
    }

    // Dismiss any other open card first
    dismissBreakdownCard();

    if (!badge._aiResult) return;

    const card = createBreakdownCard(badge._aiResult);
    postContainer.appendChild(card);

    // Close when clicking outside the card
    const closeHandler = (evt) => {
      if (!card.contains(evt.target) && evt.target !== badge) {
        card.remove();
        document.removeEventListener('click', closeHandler, true);
      }
    };
    // Delay to avoid the current click from triggering close
    setTimeout(() => {
      document.addEventListener('click', closeHandler, true);
    }, 0);
  });

  postContainer.appendChild(badge);

  return score;
}
