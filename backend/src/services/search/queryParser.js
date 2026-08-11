// Pure query grammar for lexical search. Ports msgvault's operator set
// (internal/search/parser.go); operators Mailflow's schema cannot serve
// (larger:/smaller: — no size column, bcc: — not stored, label:/l: — no
// labels) are RECORDED as unsupported, never silently widened into a match.

// Multi-char keys precede single-char `l` so the alternation resolves
// `label:` before `l:`. The leading (-?) captures optional negation; \b sits
// between an optional '-' and the key so both `from:` and `-from:` match.
const OP_KEYS = 'from|to|cc|bcc|subject|has|is|after|before|in|older_than|newer_than|larger|smaller|label|l';
const OP_PATTERN = new RegExp(`(-?)\\b(${OP_KEYS}):("([^"]*)"|([\\S]+))`, 'gi');

// Bare quoted phrases (msgvault tokenize parity, parser.go:395-464): a double-
// OR single-quoted span that STARTS a token (preceded by start/whitespace,
// optionally negated with '-') becomes ONE phrase term. A quote glued to the
// tail of a token — from:"John Smith", d'Angelo — never starts a phrase:
// operator values belong to OP_PATTERN and mid-word apostrophes are text.
// Backslash escapes keep a quote char from terminating the span.
const PHRASE_PATTERN = /(^|\s)(-?)(["'])((?:\\.|(?!\3)[^\\])*)\3/g;

// Port of msgvault's unescapeQuotedValue: `\\` and an escaped quote collapse
// to the bare char; any other `\x` keeps its backslash literally.
function unescapePhrase(s) {
  let out = '';
  let escaped = false;
  for (const ch of s) {
    if (escaped) {
      out += (ch === '\\' || ch === '"' || ch === "'") ? ch : '\\' + ch;
      escaped = false;
    } else if (ch === '\\') {
      escaped = true;
    } else {
      out += ch;
    }
  }
  if (escaped) out += '\\';
  return out;
}

// Sizes: 5M / 100K / 1G → bytes. Longer suffixes checked first. Returns null
// on anything unparseable (port of parser.go parseSize).
function parseSize(value) {
  const v = value.trim().toUpperCase();
  const mult = { KB: 1024, MB: 1048576, GB: 1073741824, K: 1024, M: 1048576, G: 1073741824 };
  for (const suffix of ['KB', 'MB', 'GB', 'K', 'M', 'G']) {
    if (v.endsWith(suffix)) {
      const num = parseFloat(v.slice(0, -suffix.length));
      if (Number.isNaN(num)) return null;
      return Math.floor(num * mult[suffix]);
    }
  }
  return /^\d+$/.test(v) ? parseInt(v, 10) : null;
}

// Relative ages: 7d / 2w / 1m / 1y → an absolute ISO timestamp relative to
// `now` (port of parser.go parseRelativeDate). Returns null if unparseable.
function relativeAgeToISO(value, now) {
  const m = /^(\d+)([dwmy])$/.exec(value.trim().toLowerCase());
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const d = new Date(now.getTime());
  switch (m[2]) {
    case 'd': d.setUTCDate(d.getUTCDate() - n); break;
    case 'w': d.setUTCDate(d.getUTCDate() - n * 7); break;
    case 'm': d.setUTCMonth(d.getUTCMonth() - n); break;
    case 'y': d.setUTCFullYear(d.getUTCFullYear() - n); break;
    default: return null;
  }
  return d.toISOString();
}

function applyOperator(key, value, negate, ctx) {
  const { filters, unsupported, errors, now } = ctx;
  switch (key) {
    case 'from': case 'to': case 'cc':
    case 'subject': case 'has': case 'is':
    case 'in':
      if (value) filters.push({ key, value, negate });
      return;
    case 'after':
    case 'before': {
      if (!value) return;
      // A bad date must be RECORDED, not silently dropped downstream
      // (buildOperatorClauses skips unparseable dates via isNaN, which would
      // silently WIDEN the results). Same uniform message parser.go's
      // operatorValueError emits for a bad before:/after: value.
      if (isNaN(new Date(value))) {
        errors.push(`invalid value "${value}" for ${key}: — expected a date like YYYY-MM-DD`);
        return;
      }
      filters.push({ key, value, negate });
      return;
    }
    case 'newer_than':
    case 'older_than': {
      const iso = relativeAgeToISO(value, now);
      if (!iso) {
        errors.push(`invalid value "${value}" for ${key}: — expected a relative age like 7d, 2w, 1m, or 1y`);
        return;
      }
      filters.push({ key: key === 'newer_than' ? 'after' : 'before', value: iso, negate });
      return;
    }
    case 'larger':
    case 'smaller': {
      if (parseSize(value) === null) {
        errors.push(`invalid value "${value}" for ${key}: — expected a size like 5M, 100K, or 1G`);
        return;
      }
      // Recognized and well-formed, but messages has no size column.
      unsupported.push({ key, token: `${key}:${value}` });
      return;
    }
    case 'bcc':
    case 'label':
    case 'l':
      // No bcc column / no labels concept in Mailflow.
      if (value) unsupported.push({ key: key === 'l' ? 'label' : key, token: `${key}:${value}` });
      return;
    default:
      return;
  }
}

export function parseQuery(raw, { now = new Date() } = {}) {
  const filters = [];
  const terms = [];
  const unsupported = [];
  const errors = [];
  const ctx = { filters, unsupported, errors, now };

  // Phase 1: lift bare quoted phrases out BEFORE the operator grammar runs, so
  // a colon inside a phrase ("subject:not an operator") can't be parsed as an
  // operator. Each phrase leaves a U+E000-delimited placeholder in the string
  // (a Private Use Area char) — restored in term order below — so phrases and
  // bare words keep their relative positions. U+E000 is stripped from the raw
  // input first, so user text can never forge a placeholder.
  const phrases = [];
  const withPhrases = (raw || '').replace(/\uE000/g, '').replace(PHRASE_PATTERN, (_, pre, neg, _q, body) => {
    const value = unescapePhrase(body);
    if (!value.trim()) return pre; // empty phrase ("") contributes nothing
    phrases.push({ value, negate: neg === '-' });
    return `${pre}\uE000${phrases.length - 1}\uE000`;
  });

  const remaining = withPhrases.replace(OP_PATTERN, (_, neg, key, _v, quoted, unquoted) => {
    const k = key.toLowerCase();
    const value = (quoted !== undefined ? quoted : (unquoted || '')).toLowerCase().trim();
    applyOperator(k, value, neg === '-', ctx);
    return ' ';
  }).trim();

  for (const word of remaining.split(/\s+/)) {
    let w = word.trim();
    if (!w || w === '-') continue; // skip blanks and a lone '-' (nothing to negate)
    const ph = /^\uE000(\d+)\uE000$/.exec(w);
    if (ph) { terms.push(phrases[Number(ph[1])]); continue; }
    let negate = false;
    if (w[0] === '-' && w.length > 1) { negate = true; w = w.slice(1); }
    terms.push({ value: w, negate });
  }

  return { filters, terms, unsupported, errors };
}

export function resolveSearchFolderScope(filters, folderParam = '') {
  let folderScope;
  let folderFuzzy = false; // in:<name> matches loosely; the folder param is exact

  for (const f of filters) {
    if (f.key !== 'in') continue;
    if (f.value === 'all') { folderScope = null; }
    else { folderScope = f.value; folderFuzzy = true; }
  }

  if (folderScope === undefined) {
    folderScope = (folderParam || '').trim() || null;
    folderFuzzy = false;
  }

  return { folderScope, folderFuzzy };
}

export function shouldExcludeTrashFromSearch(folderScope) {
  return folderScope === null;
}
