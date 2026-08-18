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
    // Values are usually already unfolded; normalize any embedded newlines.
    return raw
      .map(v => String(v).replace(/\r?\n[\t ]+/g, ' ').trim())
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

/**
 * Parse all Authentication-Results headers into a single result set.
 *
 * @param {Array<string>|Object} headers — see extractAuthResultHeaders.
 * @returns {{ dkim: string|null, spf: string|null, dmarc: string|null }}
 *   One of: 'pass' | 'fail' | 'softfail' | 'neutral' | 'none' |
 *   'temperror' | 'permerror' | null (header absent).
 *   When multiple signatures exist for one method, 'pass' wins over any
 *   other value (at least one signature verified), otherwise the first
 *   value seen is kept.
 */
export function parseAuthResults(headers) {
  const payloads = extractAuthResultHeaders(headers);
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

  const result = { dkim: null, spf: null, dmarc: null };
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
