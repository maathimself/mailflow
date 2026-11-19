const FORWARD_EMAIL_RE = /^[^\s@<>(),;:]+@[^\s@<>(),;:]+\.[^\s@<>(),;:]+$/;

export function isValidForwardAddress(value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return !/[\r\n\0]/.test(normalized) && FORWARD_EMAIL_RE.test(normalized);
}

// The rule editor's copy of the server's label name rules (inboxRules.js labelNameError, D#751),
// so a name the server would refuse is caught before saving: the locale key that says why, or null.
export const MAX_LABEL_NAME_LENGTH = 100;
const hasControlCharacter = value => [...value].some(ch => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f);
export function labelNameErrorKey(name) {
  const value = typeof name === 'string' ? name.trim() : '';
  if (!value) return 'admin.rules.errorLabelEmpty';
  if (value.length > MAX_LABEL_NAME_LENGTH || /[*%\\]/.test(value) || hasControlCharacter(value)) return 'admin.rules.errorLabelInvalid';
  const parts = value.split('/');
  if (parts.some(part => !part.trim() || part === '.' || part === '..')) return 'admin.rules.errorLabelInvalid';
  if (parts[0].trim().toUpperCase() === 'INBOX') return 'admin.rules.errorLabelInvalid';
  return null;
}
