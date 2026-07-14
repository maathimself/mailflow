// Sanitisers for the flat, top-level GTD preference keys wired through
// PATCH /auth/preferences. Kept as a pure, index-free helper so the allow-list
// behaviour and shape bounds are unit-testable —
// the auth route itself imports the running app and can't be loaded in isolation.
//
// These are FLAT top-level prefs (not nested under a `gtd` object) because the PATCH
// handler merges with `preferences || jsonb_build_object(...)`, a shallow, top-level-key
// merge: a nested `gtd` object would be replaced wholesale on every write, so two
// browser tabs each PATCHing a different nested field from their own stale snapshot
// would clobber each other's sibling field. Flat top-level keys merge independently,
// so concurrent tabs writing different keys can never drop each other's writes.

const MAX_COLLAPSED_KEYS = 20;
const MAX_KEY_LEN = 40;
// gtdCollapsedSections: a flat { section: boolean } map. Non-objects/arrays → null.
// Values are coerced to booleans; keys are length-bounded and count-capped so the
// stored JSONB can't grow unbounded from a crafted payload.
function sanitizeCollapsed(value) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return null;
  const clean = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof k !== 'string' || k.length === 0 || k.length > MAX_KEY_LEN) continue;
    clean[k] = Boolean(v);
    if (Object.keys(clean).length >= MAX_COLLAPSED_KEYS) break;
  }
  return clean;
}

// gtdPetSlug: which cached imported pet to render at inbox-zero. The value is always a
// canonical slug (the import derives it server-side and hands it back), so only a bare
// slug is accepted here. Three outcomes:
//   - a valid slug     → store it
//   - '' (empty/blank) → store '' (explicit "clear", reverting to the dog)
//   - absent / invalid → null (leave the stored value untouched)
// The '' sentinel is why this returns null only for skip: the SQL sets the key when
// the param is non-null, so '' clears while null is a no-op.
const PET_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
function sanitizePetSlug(value) {
  if (value === undefined) return null;
  if (typeof value !== 'string') return null;
  const s = value.trim().toLowerCase();
  if (s === '') return '';
  return PET_SLUG_RE.test(s) ? s : null;
}

export function sanitizeGtdPrefs(body = {}) {
  return {
    gtdCollapsedSections: sanitizeCollapsed(body.gtdCollapsedSections),
    gtdPetSlug: sanitizePetSlug(body.gtdPetSlug),
  };
}
