// Client-side diagnostics report assembly. Collects the environment section,
// asks the backend for the sanitized server section (accounts/folders/counts/
// config, all id-hashed with a per-report salt), merges, and runs a final PII
// scrub as a safety net. Nothing is sent anywhere — the caller downloads/copies
// the result and shares it manually.

import { api } from './api.js';
import { getDiagEvents } from './diagEvents.js';

const REPORT_SCHEMA_VERSION = 1;

export function randomHex(bytes = 16) {
  const a = new Uint8Array(bytes);
  (globalThis.crypto || {}).getRandomValues?.(a);
  return Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
}

// Matches the backend hashRef exactly: sha256(`${salt}:${id}`) truncated to 8 hex
// chars, so event accountRefs correlate with the accounts[] refs in the same report.
export async function hashRefAsync(id, salt) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}:${id}`));
  return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('').slice(0, 8);
}

// Reduce a full User-Agent string to just browser family + major and OS family,
// so nothing fingerprintable (exact build, device model, plugins) is included.
export function coarsenUserAgent(ua = '') {
  const s = String(ua);
  let browser = 'unknown';
  let m;
  if ((m = s.match(/Edg\/(\d+)/))) browser = `Edge ${m[1]}`;
  else if ((m = s.match(/OPR\/(\d+)/))) browser = `Opera ${m[1]}`;
  else if ((m = s.match(/Firefox\/(\d+)/))) browser = `Firefox ${m[1]}`;
  else if ((m = s.match(/Chrome\/(\d+)/))) browser = `Chrome ${m[1]}`;
  else if ((m = s.match(/Version\/(\d+).*Safari/))) browser = `Safari ${m[1]}`;

  let os = 'unknown';
  if (/Windows NT/.test(s)) os = 'Windows';
  else if (/iPhone|iPad|iPod/.test(s)) os = 'iOS';
  else if (/Mac OS X/.test(s)) os = 'macOS';
  else if (/Android/.test(s)) os = 'Android';
  else if (/Linux/.test(s)) os = 'Linux';
  return { browser, os };
}

// PII safety net — mirrors backend services/diagnosticsReport.js. On a normal
// instance the allowlist has already excluded everything, so this should be inert.
const PII_PATTERNS = [
  /[\w.+-]+@[\w-]+\.[\w.-]+/,
  /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/,
  /\beyJ[\w-]+\.[\w-]+\.[\w-]+/,
  /\b[A-Fa-f0-9]{32,}\b/,
  /(ghp_|gho_|sk-|xoxb-|Bearer\s+\S)/i,
];

export function scrubReport(obj) {
  const counters = { fieldsDropped: 0, hitsRedacted: 0 };
  const walk = (v) => {
    if (typeof v === 'string') {
      if (PII_PATTERNS.some(re => re.test(v))) { counters.hitsRedacted += 1; return '[redacted]'; }
      return v;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, val] of Object.entries(v)) out[k] = walk(val);
      return out;
    }
    return v;
  };
  return { scrubbed: walk(obj), counters };
}

export function collectEnvironment({ locale, theme, uiScale }) {
  const native = typeof window !== 'undefined' ? window.mailexpertNative : null;
  const { browser, os } = coarsenUserAgent(typeof navigator !== 'undefined' ? navigator.userAgent : '');
  return {
    platform: native ? (native.platform || 'native') : 'web',
    browser,
    os,
    locale: locale || 'en',
    theme: theme || 'unknown',
    uiScale: uiScale ?? 1,
    tzOffsetMinutes: new Date().getTimezoneOffset(),
    viewport: {
      w: typeof window !== 'undefined' ? window.innerWidth : null,
      h: typeof window !== 'undefined' ? window.innerHeight : null,
      dpr: typeof window !== 'undefined' ? window.devicePixelRatio : null,
    },
  };
}

// Build the full sanitized report. Returns { report, json }.
export async function generateReport({ locale, theme, uiScale }) {
  const salt = randomHex(16);
  const server = await api.diagnosticsReport(salt);

  // Client-side event trace, with account ids hashed using the same salt so they
  // correlate with the server-provided account refs.
  const rawEvents = getDiagEvents();
  const ids = [...new Set(rawEvents.map(e => e.accountId).filter(Boolean))];
  const refMap = new Map();
  for (const id of ids) refMap.set(id, await hashRefAsync(id, salt));
  const events = rawEvents.map(({ accountId, ...rest }) => (
    accountId ? { ...rest, accountRef: refMap.get(accountId) } : rest
  ));

  const merged = {
    meta: {
      schemaVersion: REPORT_SCHEMA_VERSION,
      reportId: randomHex(6),
      generatedAt: new Date().toISOString(),
    },
    versions: {
      app: server?.versions?.backend ?? 'unknown',
      backendSha: server?.versions?.gitSha ?? 'unknown',
      frontendSha: import.meta.env.VITE_BUILD_SHA || 'dev',
    },
    environment: collectEnvironment({ locale, theme, uiScale }),
    server: server?.server ?? {},
    accounts: server?.accounts ?? [],
    folders: server?.folders ?? [],
    counts: server?.counts ?? {},
    events,
    warnings: server?.warnings ?? [],
    syncSignals: server?.syncSignals ?? [],
    connection: server?.connection ?? {},
    performance: server?.performance ?? {},
    config: server?.config ?? {},
  };

  const { scrubbed, counters } = scrubReport(merged);
  const serverScrub = server?.scrub ?? { fieldsDropped: 0, hitsRedacted: 0 };
  scrubbed.scrub = {
    fieldsDropped: (serverScrub.fieldsDropped || 0) + counters.fieldsDropped,
    hitsRedacted: (serverScrub.hitsRedacted || 0) + counters.hitsRedacted,
  };

  return {
    report: scrubbed,
    json: JSON.stringify(scrubbed, null, 2),
  };
}
