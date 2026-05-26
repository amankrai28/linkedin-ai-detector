#!/usr/bin/env node
/**
 * Merge a downloaded extraction file into benchmark/labeled-set.json.
 *
 * Usage:
 *   node merge-extracted.js <path-to-extracted.json> <profile-name> <profile-url>
 *
 * Example:
 *   node merge-extracted.js ~/Downloads/profile-extracted.json "Author Name" \
 *     "https://www.linkedin.com/in/example-slug/"
 *
 * Each post is added with:
 *   label: "ai"
 *   ai_involvement: 0.85   (heavy AI, light human polish)
 *   confidence: "high"     (user named these profiles as reliably AI)
 *   source.type: "named-profile"
 *
 * Dedupes by URN against existing posts in labeled-set.json.
 */

const fs = require('fs');
const path = require('path');

const SCRIPT_DIR = __dirname;
const LABELED_SET = path.join(SCRIPT_DIR, 'labeled-set.json');

const [, , extractedPath, profileName, profileUrl] = process.argv;
if (!extractedPath || !profileName || !profileUrl) {
  console.error('Usage: node merge-extracted.js <extracted.json> <profile-name> <profile-url>');
  process.exit(1);
}

const extracted = JSON.parse(fs.readFileSync(extractedPath.replace(/^~/, process.env.HOME), 'utf-8'));
const set = JSON.parse(fs.readFileSync(LABELED_SET, 'utf-8'));

const existingUrns = new Set(set.posts.map(p => p.id));
const today = new Date().toISOString().slice(0, 10);

let added = 0;
let skipped = 0;
for (const p of extracted) {
  if (existingUrns.has(p.urn)) { skipped++; continue; }
  set.posts.push({
    id: p.urn,
    text: p.text,
    wordCount: p.wordCount,
    label: 'ai',
    ai_involvement: 0.85,
    confidence: 'high',
    source: {
      type: 'named-profile',
      profileUrl,
      profileName,
      postUrl: p.postUrl,
      collectedAt: today
    },
    notes: 'Named AI-profile per user. Heavy AI drafting with human polish.'
  });
  added++;
}

fs.writeFileSync(LABELED_SET, JSON.stringify(set, null, 2) + '\n');
console.log(`Added ${added}, skipped ${skipped} duplicates. Total posts in set: ${set.posts.length}.`);
