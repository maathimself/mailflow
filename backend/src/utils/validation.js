// Validate a folder name / path component: no control chars, max 255 chars.
export function isValidFolderName(name) {
  // eslint-disable-next-line no-control-regex -- intentionally rejecting control characters
  return typeof name === 'string' && name.length > 0 && name.length <= 255 && !/[\x00-\x1f\x7f]/.test(name);
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function areValidUUIDs(ids) {
  return ids.every(id => typeof id === 'string' && UUID_RE.test(id));
}
