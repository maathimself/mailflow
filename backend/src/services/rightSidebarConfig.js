import { query } from './db.js';

const MAX_LABELS = 40;
const MAX_PATH_LENGTH = 255;
const CACHE_TTL_MS = 5 * 60 * 1000;
const RESERVED_FOLDER_NAMES = new Set([
  'inbox', 'sent', 'sent items', 'sent mail', 'draft', 'drafts',
  'trash', 'bin', 'junk', 'spam', 'archive', 'all mail',
]);

const configCache = new Map();

export function isReservedFolderPath(path) {
  const lower = path.toLowerCase();
  const segments = lower.split(/[\\/]/).map(segment => segment.trim());
  return segments.some(segment => RESERVED_FOLDER_NAMES.has(segment))
    || /^\[gmail\][\\/]/.test(lower);
}

function hasTraversalSegment(path) {
  return path.split(/[\\/]/).includes('..');
}

function hasControlCharacter(path) {
  return [...path].some(char => {
    const code = char.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

export function sanitizeRightSidebarLabels(value) {
  if (value == null) return { labels: [], rejected: [] };
  if (!Array.isArray(value)) return { labels: [], rejected: [value] };

  const labels = [];
  const rejected = [];
  for (const raw of value) {
    const path = typeof raw === 'string' ? raw.trim() : '';
    if (!path || path.length > MAX_PATH_LENGTH || hasControlCharacter(path)
      || hasTraversalSegment(path) || isReservedFolderPath(path)) {
      rejected.push(raw);
      continue;
    }
    if (labels.includes(path)) continue;
    if (labels.length >= MAX_LABELS) {
      rejected.push(raw);
      continue;
    }
    labels.push(path);
  }
  return { labels, rejected };
}

export function invalidateRightSidebarConfig(accountId) {
  configCache.delete(accountId);
}

export async function getRightSidebarConfig(accountId) {
  const cached = configCache.get(accountId);
  if (cached && cached.expiry > Date.now()) return cached.labels;

  const result = await query(
    'SELECT right_sidebar_labels FROM email_accounts WHERE id = $1',
    [accountId]
  );
  const labels = sanitizeRightSidebarLabels(result.rows[0]?.right_sidebar_labels).labels;
  configCache.set(accountId, { labels, expiry: Date.now() + CACHE_TTL_MS });
  return labels;
}
