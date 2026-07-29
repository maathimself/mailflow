const FORWARD_EMAIL_RE = /^[^\s@<>(),;:]+@[^\s@<>(),;:]+\.[^\s@<>(),;:]+$/;

export function isValidForwardAddress(value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return !/[\r\n\0]/.test(normalized) && FORWARD_EMAIL_RE.test(normalized);
}
