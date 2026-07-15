// Server-side "is a newer release available" check for #261.
//
// The BACKEND queries GitHub's releases API — host-pinned, no user input in the URL,
// via safeFetch (blocks private/rebinding targets) — at most once per TTL and caches
// the result. Users' browsers never contact GitHub and no user data leaves the server;
// GitHub only sees that a MailFlow instance checked for an update. Set
// UPDATE_CHECK_DISABLED=true to turn the check off entirely (air-gapped deployments).
import { safeFetch } from './safeFetch.js';

const REPO = (process.env.UPDATE_CHECK_REPO || 'maathimself/mailflow').replace(/[^\w./-]/g, '');
const RELEASES_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
export const RELEASES_PAGE = `https://github.com/${REPO}/releases`;

const TTL_MS = 6 * 60 * 60 * 1000;        // re-query GitHub at most every 6 hours
const FAIL_BACKOFF_MS = 15 * 60 * 1000;   // after a failed check, retry no sooner than 15 min
const DISABLED = /^(1|true|yes|on)$/i.test(process.env.UPDATE_CHECK_DISABLED || '');

let cache = { latest: null, url: null };
let nextCheck = 0;

function parse(v) {
  const m = String(v || '').trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function isNewer(latest, current) {
  const a = parse(latest), b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

async function refresh() {
  const res = await safeFetch(RELEASES_URL, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'MailFlow-update-check' },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}`);
  const data = await res.json();
  const tag = String(data.tag_name || '').trim().replace(/^v/i, '');
  return { latest: tag || null, url: typeof data.html_url === 'string' ? data.html_url : null };
}

export async function getUpdateStatus(currentVersion) {
  if (DISABLED) {
    return { current: currentVersion, latest: null, updateAvailable: false, disabled: true };
  }
  const now = Date.now();
  if (now >= nextCheck) {
    nextCheck = now + TTL_MS;               // reserve the window first so concurrent calls don't all refetch
    try {
      cache = await refresh();
    } catch {
      nextCheck = now + FAIL_BACKOFF_MS;    // keep any prior good cache; retry sooner
    }
  }
  return {
    current: currentVersion,
    latest: cache.latest,
    url: cache.url || RELEASES_PAGE,
    updateAvailable: cache.latest ? isNewer(cache.latest, currentVersion) : false,
    disabled: false,
  };
}
