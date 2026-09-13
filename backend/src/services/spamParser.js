// Authentication-Results header parser (v0.2).
//
// Parses the `Authentication-Results:` header per RFC 7601 (updated by
// RFC 8601). NOTE: RFC 8054 is about NNTP compression and must NOT be
// used as a reference here (ADR-001 v2 correction).
//
// Typical Gmail header:
//   Authentication-Results: mx.google.com;
//     dkim=pass header.i=@example.com header.s=sel header.b=xyz;
//     spf=pass (google.com: domain of sender@example.com designates ...) smtp.mailfrom=sender@example.com;
//     dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=example.com
//
// The parser is defensive: it accepts an array of raw header lines
// (with optional "Authentication-Results:" prefix) or an object map of
// lowercase header names -> values, and returns the three results the
// spam classifier consumes (dkim, spf, dmarc). Unknown methods and
// malformed segments are ignored.

const KNOWN_METHODS = new Set(['dkim', 'spf', 'dmarc']);

// Values that count as an authentication "pass" for feature extraction.
// best_guess_pass (RFC 8601 §2.2.2) is a soft pass used when no signature
// exists; the design doc treats it as pass (weak ham signal).
const PASS_VALUES = new Set(['pass', 'best_guess_pass']);

/**
 * Normalize a raw header line set into a list of Authentication-Results
 * payload strings (one per header instance, unfolded).
 *
 * @param {Array<string>|Object} headers
 *   Either an array of raw header lines (may include or omit the
 *   "Authentication-Results:" label), or an object keyed by lowercase
 *   header name with string / string[] values (the shape produced by
 *   message parsers).
 * @returns {Array<string>} unfolded payloads, e.g. ["mx.google.com; dkim=pass ..."]
 */
export function extractAuthResultHeaders(headers) {
  if (Array.isArray(headers)) {
    const unfolded = unfoldHeaderLines(headers);
    return unfolded
      .filter(line => /^authentication-results\s*:/i.test(line))
      .map(line => line.replace(/^authentication-results\s*:\s*/i, ''));
  }
  if (headers && typeof headers === 'object') {
    const value = headers['authentication-results'] ?? headers['Authentication-Results'];
    if (value === undefined) return [];
    const raw = Array.isArray(value) ? value : [value];
    // The ingestion parser (messageParser.parseHeadersInput) keys headers by
    // lowercase name and joins repeated instances with '\n', so one map value
    // can hold several Authentication-Results headers (and folded
    // continuations). Split on newlines and unfold, exactly like the raw-line
    // path, so each header keeps its own authserv-id for the trust gate.
    const lines = [];
    for (const v of raw) {
      for (const line of String(v).replace(/\r\n/g, '\n').split('\n')) lines.push(line);
    }
    return unfoldHeaderLines(lines)
      .map(line => line.replace(/^authentication-results\s*:\s*/i, '').trim())
      .filter(v => v.length > 0);
  }
  return [];
}

// Folded headers continue on lines starting with whitespace. Unfold them
// first so the regexes see one logical header.
function unfoldHeaderLines(lines) {
  const result = [];
  for (const line of lines) {
    const text = String(line);
    if (/^[\t ]/.test(text) && result.length > 0) {
      result[result.length - 1] += ' ' + text.trim();
    } else {
      result.push(text.trim());
    }
  }
  return result;
}

// Trust gate (PR review, 2026-08-25). An Authentication-Results header is only
// meaningful when it was written by a mail system the account owner trusts: a
// sender can add their own `Authentication-Results: x; dkim=pass; spf=pass;
// dmarc=pass`, and because RFC 7601 permits multiple such headers (and 'pass'
// wins across them in this parser), an untrusted header could both earn the
// pass weights and silence the AUTH_*_FAIL rules. Callers therefore pass the
// authserv-id(s) they trust (`email_accounts.trusted_authserv_id`); with no
// trusted id configured, NO header is honored and the auth signal is neutral.

/**
 * Extract the authserv-id of one Authentication-Results payload — the first
 * token before the first ';' (RFC 8601 §2.2: "authserv-id [authserv-id-version]").
 * Parenthesised comments are dropped and an authserv-id-version suffix after
 * '/' is tolerated (seen in the wild as "example.com/1").
 *
 * @param {string} payload e.g. "mx.google.com 1; dkim=pass ..."
 * @returns {string|null} lowercase authserv-id, or null when there is none
 */
export function extractAuthservId(payload) {
  const first = String(payload ?? '').split(';')[0];
  const stripped = first.replace(/\([^)]*\)/g, ' ').trim();
  const token = stripped.split(/\s+/)[0] || '';
  const id = token.split('/')[0].trim().toLowerCase();
  return id || null;
}

/** Normalize a user-configured trusted authserv-id for comparison. */
export function normalizeAuthservId(value) {
  if (typeof value !== 'string') return null;
  const id = value.trim().toLowerCase().split('/')[0].trim();
  return id || null;
}

/**
 * Every distinct authserv-id seen across the Authentication-Results headers,
 * in header order. Used by the "detected values" helper in the account form and
 * recorded in spam_details for diagnostics — never for scoring by itself.
 *
 * @param {Array<string>|Object} headers — see extractAuthResultHeaders.
 * @returns {Array<string>} lowercase authserv-ids (deduplicated)
 */
export function extractAuthservIds(headers) {
  const seen = [];
  for (const payload of extractAuthResultHeaders(headers)) {
    const id = extractAuthservId(payload);
    if (id && !seen.includes(id)) seen.push(id);
  }
  return seen;
}

/**
 * Normalize the trusted-id option into a Set of lowercase ids.
 * Accepts a string, an array, or nothing.
 */
function trustedSet(trustedAuthservIds) {
  const list = Array.isArray(trustedAuthservIds)
    ? trustedAuthservIds
    : trustedAuthservIds == null ? [] : [trustedAuthservIds];
  return new Set(list.map(normalizeAuthservId).filter(Boolean));
}

/**
 * True when the message carries at least one Authentication-Results header
 * written by a trusted authserv-id. The rules engine uses this (instead of
 * "any Authentication-Results header exists") so an untrusted header is treated
 * exactly like an absent one — neutral, never firing AUTH_*_FAIL.
 */
export function hasTrustedAuthResults(headers, trustedAuthservIds) {
  const trusted = trustedSet(trustedAuthservIds);
  if (trusted.size === 0) return false;
  return extractAuthResultHeaders(headers).some(payload => {
    const id = extractAuthservId(payload);
    return id !== null && trusted.has(id);
  });
}

/**
 * Parse all Authentication-Results headers into a single result set, honoring
 * only the headers written by a trusted authserv-id.
 *
 * @param {Array<string>|Object} headers — see extractAuthResultHeaders.
 * @param {Object} [opts]
 *   @param {string|Array<string>} [opts.trustedAuthservIds] — authserv-id(s)
 *     this account trusts. Empty/absent means "trust nothing": every method is
 *     returned as null (no signal) rather than trusting whatever arrived.
 * @returns {{ dkim: string|null, spf: string|null, dmarc: string|null }}
 *   One of: 'pass' | 'fail' | 'softfail' | 'neutral' | 'none' |
 *   'temperror' | 'permerror' | null (header absent or untrusted).
 *   When multiple signatures exist for one method, 'pass' wins over any
 *   other value (at least one signature verified), otherwise the first
 *   value seen is kept.
 */
export function parseAuthResults(headers, opts = {}) {
  const trusted = trustedSet(opts.trustedAuthservIds);
  const result = { dkim: null, spf: null, dmarc: null };
  if (trusted.size === 0) return result;

  const payloads = extractAuthResultHeaders(headers).filter(payload => {
    const id = extractAuthservId(payload);
    return id !== null && trusted.has(id);
  });
  if (payloads.length === 0) return result;

  const byMethod = new Map(); // method -> first value seen (excluding pass)
  const passed = new Set();

  for (const payload of payloads) {
    const segments = splitResultSegments(payload);
    for (const segment of segments) {
      const match = /^([a-z0-9_.-]+)\s*=\s*([a-z0-9_]+)/i.exec(segment);
      if (!match) continue;
      const method = match[1].toLowerCase();
      const value = match[2].toLowerCase();
      if (!KNOWN_METHODS.has(method)) continue;
      if (PASS_VALUES.has(value)) {
        passed.add(method);
      } else if (!byMethod.has(method)) {
        byMethod.set(method, value);
      }
    }
  }

  for (const method of KNOWN_METHODS) {
    if (passed.has(method)) {
      result[method] = 'pass';
    } else if (byMethod.has(method)) {
      result[method] = byMethod.get(method);
    }
  }
  return result;
}

// Split an Authentication-Results payload into "method=result" segments.
// The first segment may carry the authserv-id (e.g. "mx.google.com" or
// "mx.google.com 1"); it is skipped because it has no "=".
// Parenthesized comments may contain "=" characters, so we split on
// semicolons first, then strip anything inside parentheses.
function splitResultSegments(payload) {
  const raw = payload.split(';');
  const segments = [];
  for (const part of raw) {
    // Strip parenthesized comments before looking for method=value.
    const stripped = part.replace(/\([^)]*\)/g, '').trim();
    if (!stripped) continue;
    if (!stripped.includes('=')) continue; // authserv-id or noise
    segments.push(stripped);
  }
  return segments;
}
