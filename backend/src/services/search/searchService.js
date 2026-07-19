import { query } from '../db.js';
import { searchLexical } from './lexicalRepo.js';
import { resolveSearchFolderScope } from './queryParser.js';

function clampLimit(limit) {
  return Math.max(1, Math.min(parseInt(limit) || 50, 200));
}

export async function search(request) {
  const { userId, accountId, parsed, folderParam = '', limit = 50, offset = 0 } = request;

  const cap = clampLimit(limit);
  const off = Math.max(0, parseInt(offset) || 0);
  const emptyPage = { offset: off, limit: cap, hasMore: false };

  const accountsResult = await query(
    'SELECT id FROM email_accounts WHERE user_id = $1 AND enabled = true',
    [userId]
  );
  let accountIds = accountsResult.rows.map(r => r.id);
  if (!accountIds.length) return { messages: [], mode: 'lexical', page: emptyPage };

  // Optional single-account narrowing, only within the authenticated user's scope.
  if (accountId && accountIds.includes(accountId)) accountIds = [accountId];

  const { folderScope, folderFuzzy } = resolveSearchFolderScope(parsed.filters, folderParam);

  // D5: a free-text search (≥1 positive, non-trivial term) ranks by relevance;
  // a filter-only search stays date-ordered.
  const hasPositiveText = parsed.terms.some(t => !t.negate && t.value.length >= 2);
  const ordering = hasPositiveText ? 'relevance' : 'date';

  const { rows, hasCondition } = await searchLexical(query, {
    parsed, accountIds, folderScope, folderFuzzy, ordering, limit: cap, offset: off,
  });
  if (!hasCondition) return { messages: [], mode: 'lexical', page: emptyPage };

  return {
    messages: rows,
    mode: 'lexical',
    page: { offset: off, limit: cap, hasMore: rows.length === cap },
  };
}
