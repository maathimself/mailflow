// Apple Contacts encodes its well-known X-ABLABEL values in a sentinel wrapper
// (`_$!<HomePage>!$_`), and a vCard property with no X-ABLABEL falls back to its raw TYPE
// token (`WORK`, `HOME`). CardDAV servers hand both through verbatim, so they reach the
// client as the label of an additional field and must be humanized for display only —
// the stored label is what the retained vCard round-trips.
const APPLE_LABEL = /^_\$!<(.*)>!\$_$/;

// Well-known label tokens, lowercased so uppercase TYPE tokens resolve like Apple's
// mixed-case labels, mapped onto localized copy the app already ships.
const LOCALIZED_LABELS = new Map([
  ['home', 'contacts.emailTypes.home'],
  ['work', 'contacts.emailTypes.work'],
  ['other', 'contacts.emailTypes.other'],
  ['mobile', 'contacts.phoneTypes.mobile'],
  ['cell', 'contacts.phoneTypes.mobile'],
  ['iphone', 'contacts.phoneTypes.mobile'],
  ['homepage', 'contacts.additional.types.url'],
  ['url', 'contacts.additional.types.url'],
  ['birthday', 'contacts.additional.types.birthday'],
  ['anniversary', 'contacts.additional.types.anniversary'],
  ['nickname', 'contacts.additional.types.nickname'],
  ['role', 'contacts.additional.types.role'],
  ['title', 'contacts.additional.types.title'],
]);

export const CONTACT_LABEL_KEYS = [...new Set(LOCALIZED_LABELS.values())];

function titleCase(token) {
  return token
    .split(/\s+/)
    .filter(Boolean)
    .map(word => word[0].toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

export function humanizeContactLabel(label, t) {
  const raw = String(label ?? '').trim();
  const inner = (APPLE_LABEL.exec(raw)?.[1] ?? raw).trim();
  if (!inner) return '';
  const key = LOCALIZED_LABELS.get(inner.toLowerCase());
  return key ? t(key) : titleCase(inner);
}

export function formatContactValue(value, t) {
  if (value === null || value === undefined || value === '') return '—';
  if (Array.isArray(value)) return value.length ? value.map(item => formatContactValue(item, t)) : '—';
  if (typeof value !== 'object') return String(value);
  if (value.kind) {
    const label = humanizeContactLabel(value.label || value.kind, t)
      || t(`contacts.additional.types.${value.kind}`);
    return `${label}: ${formatContactValue(value.value, t)}`;
  }
  return Object.values(value)
    .filter(part => part !== null && part !== undefined && part !== '' && typeof part !== 'boolean')
    .map(String)
    .join(' · ') || '—';
}
