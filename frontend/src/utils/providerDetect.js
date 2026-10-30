// Which provider an email address belongs to, for the Add account chooser: a consumer
// Microsoft address goes to "Sign in with Microsoft", Gmail, Yahoo and iCloud to their
// presets, and anything else to the IMAP form. Only the domain is looked at; a custom domain
// hosted by one of these providers is "other" (no MX lookup).

// Personal Microsoft account domains with their country variants (hotmail.co.uk, live.fr,
// outlook.com.br). The backend's isPersonalMicrosoftAccount (services/accountErrorCode.js)
// uses the same list to tell personal from work mailboxes.
const MICROSOFT_PERSONAL = /^(?:outlook|hotmail|live|msn|passport|windowslive)\.(?:com|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})$/;
const GMAIL = /^(?:gmail|googlemail)\.com$/;
const YAHOO = /^(?:yahoo|ymail|rocketmail)\.(?:com|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})$/;
const ICLOUD = /^(?:icloud|me|mac)\.com$/;

// A plain check, enough to catch typos before choosing a provider; the server validates.
const ADDRESS = /^[^\s@]+@([^\s@]+\.[^\s@]+)$/;

export function emailDomain(email) {
  const m = String(email || '').trim().toLowerCase().match(ADDRESS);
  return m ? m[1] : null;
}

// 'microsoftPersonal' | 'gmail' | 'yahoo' | 'icloud' | 'other', or null for something that
// is not an email address.
export function detectProvider(email) {
  const domain = emailDomain(email);
  if (!domain) return null;
  if (MICROSOFT_PERSONAL.test(domain)) return 'microsoftPersonal';
  if (GMAIL.test(domain)) return 'gmail';
  // Yahoo! JAPAN runs its own mail servers, which the Yahoo preset does not reach.
  if (YAHOO.test(domain) && domain !== 'yahoo.co.jp') return 'yahoo';
  if (ICLOUD.test(domain)) return 'icloud';
  return 'other';
}
