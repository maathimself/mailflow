import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LEXICAL_MODE, SEMANTIC_MODE, SEARCH_MODE_KEY,
  semanticSearchAvailable, normalizeSearchMode, readStoredSearchMode, writeStoredSearchMode,
  semanticToggleState, searchInputRightPad,
  SEARCH_ICON_BOX, SEARCH_CLUSTER_GAP, SEARCH_CLUSTER_OFFSET,
  isCurrentSearchGeneration,
} from './searchMode.js';

function fakeStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m };
}

test('semanticSearchAvailable reads the vectorAvailable field from GET /api/ai/status', () => {
  assert.equal(semanticSearchAvailable({ vectorAvailable: true }), true);
  assert.equal(semanticSearchAvailable({ vectorAvailable: false }), false);
  assert.equal(semanticSearchAvailable({ enabled: true }), false);
  assert.equal(semanticSearchAvailable(null), false);
});

test('normalizeSearchMode keeps semantic modes and coerces the rest to lexical', () => {
  assert.equal(normalizeSearchMode(SEMANTIC_MODE), 'hybrid');
  assert.equal(normalizeSearchMode('vector'), 'vector');
  assert.equal(normalizeSearchMode('nonsense'), LEXICAL_MODE);
  assert.equal(normalizeSearchMode(null), LEXICAL_MODE);
});

test('read/write round-trips through storage and clears the key on lexical', () => {
  const s = fakeStorage();
  writeStoredSearchMode(s, 'hybrid');
  assert.equal(s._m.get(SEARCH_MODE_KEY), 'hybrid');
  assert.equal(readStoredSearchMode(s), 'hybrid');
  writeStoredSearchMode(s, 'lexical');
  assert.equal(s._m.has(SEARCH_MODE_KEY), false);
  assert.equal(readStoredSearchMode(s), 'lexical');
});

test('semanticToggleState maps toggle + fallback into a tone and tooltip key', () => {
  // Off — greyed sparkle, default tooltip. Fallback is irrelevant when off.
  assert.deepEqual(
    semanticToggleState({ on: false, fellBack: false, hasQuery: false }),
    { pressed: false, tone: 'off', titleKey: 'messageList.semanticToggle' });
  assert.deepEqual(
    semanticToggleState({ on: false, fellBack: true, hasQuery: true }),
    { pressed: false, tone: 'off', titleKey: 'messageList.semanticToggle' });

  // On and serving semantic results — accent sparkle, default tooltip.
  assert.deepEqual(
    semanticToggleState({ on: true, fellBack: false, hasQuery: true }),
    { pressed: true, tone: 'on', titleKey: 'messageList.semanticToggle' });

  // On but the query is empty — nothing fell back yet, so stay in the plain
  // "on" tone even if a stale fellBack flag lingers.
  assert.deepEqual(
    semanticToggleState({ on: true, fellBack: true, hasQuery: false }),
    { pressed: true, tone: 'on', titleKey: 'messageList.semanticToggle' });

  // On + fell back + a live query — amber sparkle with the extended tooltip.
  assert.deepEqual(
    semanticToggleState({ on: true, fellBack: true, hasQuery: true }),
    { pressed: true, tone: 'fallback', titleKey: 'messageList.semanticBuildingHint' });
});

test('searchInputRightPad reserves room so a long query never slides under the icon cluster', () => {
  // With the semantic toggle: room for the sparkle + clear × + gap + edge offset.
  const bothIcons = SEARCH_CLUSTER_OFFSET + 2 * SEARCH_ICON_BOX + SEARCH_CLUSTER_GAP;
  assert.ok(searchInputRightPad(true) >= bothIcons,
    `pad ${searchInputRightPad(true)} must cover the two-icon cluster ${bothIcons}`);
  // Without it: room for the clear × alone.
  const oneIcon = SEARCH_CLUSTER_OFFSET + SEARCH_ICON_BOX;
  assert.ok(searchInputRightPad(false) >= oneIcon,
    `pad ${searchInputRightPad(false)} must cover the one-icon cluster ${oneIcon}`);
  // Showing the toggle never reserves less space than hiding it.
  assert.ok(searchInputRightPad(true) > searchInputRightPad(false));
});

test('isCurrentSearchGeneration only accepts a response from the live generation', () => {
  // Same generation captured before and after the await → apply the response.
  assert.equal(isCurrentSearchGeneration(3, 3), true);
  assert.equal(isCurrentSearchGeneration(0, 0), true);
  // Generation moved on during the await (query/mode/folder/account changed, or
  // the query was cleared) → the response is stale and must be discarded.
  assert.equal(isCurrentSearchGeneration(3, 4), false);
  assert.equal(isCurrentSearchGeneration(4, 3), false);
});
