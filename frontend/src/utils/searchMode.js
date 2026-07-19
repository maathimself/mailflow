export const LEXICAL_MODE = 'lexical';
export const SEMANTIC_MODE = 'hybrid';         // the toggle flips lexical <-> hybrid
export const SEARCH_MODE_KEY = 'mailflow_search_mode';

// Vector availability from GET /api/ai/status, which reports a flat
// `vectorAvailable` boolean (backend/src/routes/ai.js) — not a nested
// `vector.available` shape. Keep the field lookup here so a rename is a
// one-line change.
export function semanticSearchAvailable(aiStatus) {
  if (!aiStatus) return false;
  return aiStatus.vectorAvailable === true;
}

export function normalizeSearchMode(mode) {
  return mode === SEMANTIC_MODE || mode === 'vector' ? mode : LEXICAL_MODE;
}

export function readStoredSearchMode(storage) {
  try { return normalizeSearchMode(storage.getItem(SEARCH_MODE_KEY)); }
  catch { return LEXICAL_MODE; }
}

export function writeStoredSearchMode(storage, mode) {
  const m = normalizeSearchMode(mode);
  try {
    if (m === LEXICAL_MODE) storage.removeItem(SEARCH_MODE_KEY);
    else storage.setItem(SEARCH_MODE_KEY, m);
  } catch { /* storage unavailable — in-memory only */ }
  return m;
}

// Visual + aria state for the in-input semantic toggle (the sparkle icon that
// lives on the right of the search box). Pure so it can be unit-tested; the
// component maps `tone` to a CSS colour and `titleKey` to a translated tooltip
// that doubles as the button's aria-label.
//
//   off      → toggle is off (lexical). Greyed sparkle, tooltip "Semantic search".
//   on       → semantic active and serving semantic results. Accent (purple) sparkle.
//   fallback → semantic active but the backend silently fell back to lexical for
//              this query (vector index still building). Amber sparkle + an
//              extended tooltip that explains keyword results are showing. This
//              re-homes the old fallback pill-row hint onto the icon so no extra
//              row appears below the input.
export function semanticToggleState({ on, fellBack, hasQuery }) {
  if (!on) return { pressed: false, tone: 'off', titleKey: 'messageList.semanticToggle' };
  if (fellBack && hasQuery) return { pressed: true, tone: 'fallback', titleKey: 'messageList.semanticBuildingHint' };
  return { pressed: true, tone: 'on', titleKey: 'messageList.semanticToggle' };
}

// Geometry of the in-input control cluster (sparkle toggle + clear ×). Used to
// reserve enough right-padding on the search input that a long query can never
// slide under the icons. An icon button is a glyph (≤15px) plus 2×4px padding
// ≈ 23px; the cluster adds a 2px gap between the two buttons and sits 6px in
// from the input's right edge.
export const SEARCH_ICON_BOX = 23;
export const SEARCH_CLUSTER_GAP = 2;
export const SEARCH_CLUSTER_OFFSET = 6;

// Right-padding (px) the search input must reserve. With the semantic toggle
// visible the cluster can hold both the sparkle and the clear ×; without it,
// only the clear × can appear. The trailing +4 is breathing room so the glyph
// never touches the text.
export function searchInputRightPad(semanticAvailable) {
  const icons = semanticAvailable ? 2 : 1;
  return SEARCH_CLUSTER_OFFSET + icons * SEARCH_ICON_BOX + (icons - 1) * SEARCH_CLUSTER_GAP + 4;
}

// The whole search context — query text, mode (lexical/hybrid), folder/scope,
// account selection, page size — is identified by a single monotonically
// increasing generation counter that the initial-search effect bumps whenever
// any of those change (or the query is cleared). Every async search response
// (first page, "load more" append, post-delete prefetch) captures the
// generation before its await and must be discarded unless it still matches the
// live one. Keying on the generation instead of comparing individual fields
// guards against every context change at once — e.g. a hybrid page 2 that
// resolves after the user toggled Semantic off must not append onto the fresh
// lexical page — and automatically covers any search param added later.
export function isCurrentSearchGeneration(capturedGeneration, currentGeneration) {
  return capturedGeneration === currentGeneration;
}
