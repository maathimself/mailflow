function isValidDomain(domain) {
  if (!domain || domain.length > 253 || domain.startsWith('.') || domain.endsWith('.')) return false;
  return domain.split('.').every(label => (
    label.length > 0
    && label.length <= 63
    && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label)
  ));
}

export function normalizeEmailAddress(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  // eslint-disable-next-line no-control-regex -- sender addresses containing control characters are invalid
  if (!normalized || /[\s<>\u0000-\u001f\u007f]/.test(normalized)) return null;
  const parts = normalized.split('@');
  if (parts.length !== 2 || !parts[0] || !isValidDomain(parts[1])) return null;
  return normalized;
}

export function normalizeWildcardAddress(value) {
  if (typeof value !== 'string') return null;
  const match = /^\*@([^@]+)$/.exec(value.trim().toLowerCase());
  return match && isValidDomain(match[1]) ? `*@${match[1]}` : null;
}

export function normalizeSenderAddress(value) {
  return normalizeWildcardAddress(value) || normalizeEmailAddress(value);
}

// Identity display names and provider address labels become message headers; reject
// control characters so they cannot inject extra header lines. Shared by the alias
// sync and sender-authorization paths.
export function hasHeaderControlCharacters(value) {
  // eslint-disable-next-line no-control-regex -- header-unsafe control characters
  return /[\u0000-\u001f\u007f]/.test(value);
}

export function wildcardCovers(pattern, candidate) {
  const normalizedPattern = normalizeWildcardAddress(pattern);
  const normalizedCandidate = normalizeEmailAddress(candidate);
  return Boolean(
    normalizedPattern
    && normalizedCandidate
    && normalizedCandidate.slice(normalizedCandidate.lastIndexOf('@') + 1) === normalizedPattern.slice(2)
  );
}
