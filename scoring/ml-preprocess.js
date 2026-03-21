/**
 * LinkedIn AI Detector — ML Text Preprocessor
 * Cleans LinkedIn post text before ML inference.
 * Adapted from Fakespot's clean_text() utility + LinkedIn-specific patterns.
 * Only used for ML scoring — heuristics use raw text for pattern detection.
 */

// eslint-disable-next-line no-unused-vars
function preprocessForML(text) {
  let t = text;
  // Remove URLs
  t = t.replace(/https?:\/\/\S+/gi, '');
  // Remove @mentions
  t = t.replace(/@[\w-]+/g, '');
  // Strip hashtags but keep the word: #leadership → leadership
  t = t.replace(/#(\w+)/g, '$1');
  // Remove emojis and pictographic characters
  t = t.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '');
  // Normalize whitespace (from Fakespot's clean_text)
  t = t.replace(/\n/g, ' ');
  t = t.replace(/\t/g, ' ');
  t = t.replace(/\r/g, ' ');
  t = t.replace(/ ,/g, ',');
  t = t.replace(/ +/g, ' ');
  return t.trim();
}
