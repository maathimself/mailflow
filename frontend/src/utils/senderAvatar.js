export function senderDomainFromEmail(email) {
  if (typeof email !== 'string') return null;
  const value = email.trim();
  const firstAt = value.indexOf('@');
  if (firstAt <= 0 || firstAt !== value.lastIndexOf('@')) return null;
  const rawDomain = value.slice(firstAt + 1);
  if (!rawDomain || /[/:\\\s?#]/.test(rawDomain)) return null;
  let parsed;
  try { parsed = new URL(`https://${rawDomain}`); }
  catch { return null; }
  const domain = parsed.hostname.toLowerCase().replace(/[.]$/, '');
  if (!domain.includes('.') || /^\d{1,3}(?:[.]\d{1,3}){3}$/.test(domain) || domain.includes(':')) return null;
  const labels = domain.split('.');
  if (labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null;
  return domain;
}

export function avatarImageCandidates({ email, hasContactPhoto, senderFavicons }) {
  const trimmed = typeof email === 'string' ? email.trim() : '';
  if (!trimmed) return [];
  const candidates = [];
  if (hasContactPhoto !== false) {
    candidates.push({ kind: 'contact', src: `/api/contacts/photo?email=${encodeURIComponent(trimmed)}` });
  }
  if (senderFavicons) {
    const domain = senderDomainFromEmail(trimmed);
    if (domain) candidates.push({ kind: 'favicon', src: `/api/sender-favicons/${encodeURIComponent(domain)}` });
  }
  return candidates;
}
