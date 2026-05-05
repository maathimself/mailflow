// Returns "first-char***@domain" — enough to identify an account in logs
// without exposing the full address to log aggregators or ops staff.
export function redactEmail(email) {
  if (typeof email !== 'string' || !email.includes('@')) return '[email]';
  const at = email.indexOf('@');
  return email[0] + '***' + email.slice(at);
}
