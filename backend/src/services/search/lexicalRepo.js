import { shouldExcludeTrashFromSearch } from './queryParser.js';

// Postgres refuses to build a tsvector larger than ~1MB of packed lexemes
// (SQLSTATE 54000). Cap the text fed to to_tsvector at 600k chars — matching
// msgvault's maxFTSBodyChars (internal/store/dialect_pg.go). Reused by the
// slice-02 search_fts trigger and backfill via searchFtsExpr().
export const FTS_BODY_CHAR_CAP = 600000;

// Single source of truth for the stored-tsvector layout version. The trigger
// and backfill both stamp fts_version = FTS_VERSION; a layout/dictionary
// change bumps this and re-runs the backfill.
export const FTS_VERSION = 1;

// Wraps a positive condition so that when negated it also matches rows where
// the underlying columns are NULL.
export function negateCond(sql) {
  return `NOT COALESCE((${sql}), false)`;
}

export function trashFolderExclusionCondition() {
  return `NOT EXISTS (
        SELECT 1
        FROM folders f
        WHERE f.account_id = m.account_id
          AND f.path = m.folder
          AND (f.special_use = '\\Trash'
               OR lower(f.name) LIKE '%trash%'
               OR lower(f.name) LIKE '%deleted%')
      )`;
}

// One free-text term matches if it appears in the sender, subject, the stored
// search_vector, or the length-capped body. Extracted so the body cap is a
// single, testable source of truth (the ranked, search_fts-first variant takes
// over once rows are backfilled).
export function freeTextTermCondition(likeIdx, ftsIdx) {
  return `(
        m.from_name ILIKE $${likeIdx}
        OR m.from_email ILIKE $${likeIdx}
        OR m.subject ILIKE $${likeIdx}
        OR m.search_vector @@ plainto_tsquery('english', $${ftsIdx})
        OR to_tsvector('english', LEFT(coalesce(m.body_text,''), ${FTS_BODY_CHAR_CAP})) @@ plainto_tsquery('english', $${ftsIdx})
      )`;
}

// BM25-style lexical rank (ts_rank_cd; class weights D,C,B,A → 10:4:1
// subject:from:rest; length normalization 32).
export const LEXICAL_RANK_SQL = (vectorExpr, queryExpr) =>
  `ts_rank_cd(ARRAY[0.1, 0.1, 0.4, 1.0]::real[], ${vectorExpr}, ${queryExpr}, 32)`;

// A term counts as searchable text only if it has at least one letter or
// digit; msgvault's hasFTSToken drops punctuation-only tokens ("!!!", "***")
// the same way, since they'd normalize to zero lexemes and can't usefully
// match or rank anything.
export function hasSearchableToken(term) {
  return /[\p{L}\p{N}]/u.test(term);
}

// A bare free-text word is a single search token; a term containing whitespace
// only arises from a quoted multi-word phrase (queryParser doesn't emit these
// today, but the builders below stay correct if it ever does). Phrases keep
// ordinary non-prefix matching — prefix-expanding a multi-word phrase isn't a
// single lexeme operation and would change its meaning.
function isPhraseTerm(term) {
  return /\s/.test(term);
}

// msgvault's BuildFTSArg prefix-matches every bare word (typing "amaz" still
// finds "amazon") — plainto_tsquery only matches whole stemmed words, which
// regressed recall vs the old ILIKE substring behavior once a row is
// backfilled onto search_fts. quote_literal($N) is a plain SQL bind param
// reference (no JS-side string building), so the raw term travels through as
// an ordinary parameter; quote_literal() at query time safely wraps it as a
// single tsquery lexeme literal — neutralizing any &, |, !, (, ), ', or :
// the term might contain — before ':*' marks it for prefix matching.
export function ftsTermQueryArg(ftsIdx, term) {
  return isPhraseTerm(term)
    ? `plainto_tsquery('english', $${ftsIdx})`
    : `to_tsquery('english', quote_literal($${ftsIdx}) || ':*')`;
}

function ftsMatchExpr(vectorExpr, ftsIdx, term) {
  return `${vectorExpr} @@ ${ftsTermQueryArg(ftsIdx, term)}`;
}

// Ranked variant used once rows carry search_fts: backfilled rows match via the
// GIN-indexed tsvector; rows not yet backfilled (search_fts IS NULL) fall back
// to the legacy ILIKE/search_vector/body branch so recall never regresses
// mid-backfill. The fallback matches nothing once search_fts is populated,
// letting the planner use the GIN index exclusively.
export function freeTextTermConditionRanked(likeIdx, ftsIdx, term) {
  return `(
        ${ftsMatchExpr('m.search_fts', ftsIdx, term)}
        OR (m.search_fts IS NULL AND ${freeTextTermCondition(likeIdx, ftsIdx)})
      )`;
}

// English stopwords ("the", "for", "you", …) normalize to an EMPTY tsquery
// (numnode = 0), and `tsvector @@ <empty>` is FALSE for every row — so one
// stopword in an AND'd term chain silently nuked ALL results once rows were
// backfilled onto search_fts ("waiting for invoice" → 0 hits, because of
// "for"; the ILIKE fallback arm is dead once search_fts is populated).
// A term whose tsquery normalizes empty must contribute NOTHING instead:
// this wraps the term's already-polarity-applied condition so it is
// vacuously TRUE — for positive AND negated terms alike — whenever the
// term's tsquery is empty. The numnode() probe runs on the SAME bind (and
// the SAME prefix-or-phrase construction, via ftsTermQueryArg) the match
// uses, so guard and match can never disagree; a query of ONLY stopwords
// degrades to a filter-only, date-ordered search. The relevance rank needs
// no guard: `&&` drops an empty tsquery operand and ts_rank_cd over a fully
// empty tsquery is 0.
export function stopwordSafeCondition(ftsIdx, term, condition) {
  return `(numnode(${ftsTermQueryArg(ftsIdx, term)}) = 0 OR ${condition})`;
}

// The one owner of a free-text term's full predicate: ranked FTS match,
// un-backfilled ILIKE fallback, polarity, and stopword vacuity. `bind(value) →
// '$n'` pushes onto the caller's params; the raw ordinals expected by
// freeTextTermConditionRanked are recovered from the placeholders.
export function freeTextTermClause(term, negate, bind) {
  const likeIdx = Number(bind(`%${term}%`).slice(1));
  const ftsIdx = Number(bind(term).slice(1));
  const cond = freeTextTermConditionRanked(likeIdx, ftsIdx, term);
  return stopwordSafeCondition(ftsIdx, term, negate ? negateCond(cond) : cond);
}

// The weighted tsvector written into messages.search_fts. `ref` is the row
// reference: 'm' for the backfill UPDATE, 'NEW' for the BEFORE trigger. The
// class weights map to ts_rank_cd's D,C,B,A array (10:4:1 subject:from:rest).
// MUST stay identical to migration 0035's trigger body.
export function searchFtsExpr(ref) {
  return `setweight(to_tsvector('english', coalesce(${ref}.subject,'')), 'A') ||
    setweight(to_tsvector('english', coalesce(${ref}.from_name,'') || ' ' || coalesce(${ref}.from_email,'')), 'B') ||
    setweight(to_tsvector('english', coalesce(${ref}.to_addresses::text,'') || ' ' || coalesce(${ref}.cc_addresses::text,'')), 'C') ||
    setweight(to_tsvector('english', LEFT(coalesce(${ref}.body_text,''), ${FTS_BODY_CHAR_CAP})), 'D')`;
}

// Structured operator predicates (from/to/cc/subject/has/is/after/before),
// negation-aware. `bind(value) → '$n'` pushes value onto the caller's param
// list and returns its placeholder — the caller owns `params`/the running
// index, so searchLexical remains the single owner of these predicates.
// Excludes free-text terms and folder scope (`in:`), which are not
// structured row predicates. Extracted from searchLexical byte-identically —
// same branches, same ILIKE-arm reuse, same skip rules.
export function buildOperatorClauses(filters, bind) {
  const conditions = [];
  for (const f of filters) {
    if (f.key === 'in') continue; // controls scope, not a row condition
    let cond = null;

    if (f.key === 'from') {
      const idx = bind(`%${f.value}%`);
      cond = `(m.from_email ILIKE ${idx} OR m.from_name ILIKE ${idx})`;
    } else if (f.key === 'subject') {
      cond = `m.subject ILIKE ${bind(`%${f.value}%`)}`;
    } else if (f.key === 'to') {
      const idx = bind(`%${f.value}%`);
      cond = `(m.to_addresses::text ILIKE ${idx} OR m.cc_addresses::text ILIKE ${idx})`;
    } else if (f.key === 'cc') {
      cond = `m.cc_addresses::text ILIKE ${bind(`%${f.value}%`)}`;
    } else if (f.key === 'has') {
      if (f.value === 'attachment' || f.value === 'attachments') cond = `m.has_attachments = true`;
    } else if (f.key === 'is') {
      if (f.value === 'unread') cond = `m.is_read = false`;
      else if (f.value === 'read') cond = `m.is_read = true`;
      else if (f.value === 'starred') cond = `m.is_starred = true`;
    } else if (f.key === 'after') {
      const d = new Date(f.value);
      if (!isNaN(d)) cond = `m.date >= ${bind(d.toISOString())}`;
    } else if (f.key === 'before') {
      const d = new Date(f.value);
      if (!isNaN(d)) cond = `m.date < ${bind(d.toISOString())}`;
    }

    if (cond) conditions.push(f.negate ? negateCond(cond) : cond);
  }
  return conditions;
}

// Folder-scope predicate(s) for the messages table. `folderScope`/`folderFuzzy` come from
// resolveSearchFolderScope: a truthy fuzzy scope (in:<name>) matches the bare
// name OR any .../<name> path; an exact scope (REST ?folder=) matches the full
// path; a null scope carries no explicit folder and excludes trash-like folders
// (the default search scope). `bind(value) → '$n'` — the caller owns params.
export function buildFolderScopeClauses(folderScope, folderFuzzy, bind) {
  const conditions = [];
  if (folderScope) {
    if (folderFuzzy) {
      const name = bind(folderScope);
      const path = bind(`%/${folderScope}`);
      conditions.push(`(m.folder ILIKE ${name} OR m.folder ILIKE ${path})`);
    } else {
      conditions.push(`m.folder = ${bind(folderScope)}`);
    }
  } else if (shouldExcludeTrashFromSearch(folderScope)) {
    conditions.push(trashFolderExclusionCondition());
  }
  return conditions;
}

export async function searchLexical(client, { parsed, accountIds, folderScope, folderFuzzy, ordering, limit, offset }) {
  const { filters, terms } = parsed;
  const params = [accountIds];
  let p = 2;
  const bind = (v) => { params.push(v); return `$${p++}`; };
  const conditions = buildOperatorClauses(filters, bind);

  for (const term of terms.slice(0, 10)) {
    // Single-char terms are too broad/expensive; a punctuation-only term
    // (e.g. "!!!") has no letters/digits to search on — msgvault's
    // hasFTSToken drops it the same way rather than handing Postgres a
    // token that would normalize to zero lexemes.
    if (term.value.length < 2 || !hasSearchableToken(term.value)) continue;
    conditions.push(freeTextTermClause(term.value, term.negate, bind));
  }

  // A bare in:inbox (or lone folder param) must never dump a whole folder.
  if (!conditions.length) return { rows: [], hasCondition: false };

  for (const cond of buildFolderScopeClauses(folderScope, folderFuzzy, bind)) conditions.push(cond);

  // D5: rank a free-text search by ts_rank_cd over the combined positive terms
  // (date/id tiebreak); a filter-only search stays date-ordered. The rank arg
  // must be bound before LIMIT/OFFSET.
  let orderBy = 'ORDER BY m.date DESC';
  const positiveTerms = terms.slice(0, 10)
    .filter(t => !t.negate && t.value.length >= 2 && hasSearchableToken(t.value))
    .map(t => t.value);
  if (ordering === 'relevance' && positiveTerms.length) {
    // Rank with the SAME prefix-aware tsquery the MATCH predicate uses
    // (freeTextTermConditionRanked → ftsTermQueryArg): one bind per term,
    // combined with && (ts_rank_cd takes a single tsquery). Reusing the one
    // term→tsquery-arg builder is what makes
    // predicate and rank impossible to diverge — a prefix-only hit ("invo"
    // matching "invoice") then ranks by ts_rank_cd instead of getting rank 0
    // (which COALESCE(...,0) would collapse to date order). Phrases keep
    // non-prefix matching via ftsTermQueryArg, exactly as the predicate does.
    const rankArgs = positiveTerms.map((term) => { params.push(term); return p++; });
    const rankQuery = positiveTerms.map((term, i) => ftsTermQueryArg(rankArgs[i], term)).join(' && ');
    const rankExpr = LEXICAL_RANK_SQL('m.search_fts', rankQuery);
    // ts_rank_cd(..., NULL::tsvector, ...) returns NULL for un-backfilled rows
    // (search_fts IS NULL), and Postgres sorts NULLs FIRST in DESC order — so
    // without COALESCE every un-backfilled row would outrank every properly
    // ranked hit during the backfill window. COALESCE(...,0) keeps them
    // sorting by the date/id tiebreak instead, below any real rank score.
    orderBy = `ORDER BY COALESCE(${rankExpr}, 0) DESC, m.date DESC, m.id DESC`;
  }

  params.push(limit);
  params.push(offset);

  const result = await client(`
      SELECT
        m.id, m.uid, m.folder, m.subject, m.from_name, m.from_email,
        m.date, m.snippet, m.is_read, m.is_starred, m.has_attachments, m.account_id,
        a.name as account_name, a.email_address as account_email, a.color as account_color
      FROM messages m
      JOIN email_accounts a ON m.account_id = a.id
      WHERE m.account_id = ANY($1)
        AND m.is_deleted = false
        AND ${conditions.join('\n        AND ')}
      ${orderBy}
      LIMIT $${p} OFFSET $${p + 1}
    `, params);

  return { rows: result.rows, hasCondition: true };
}
