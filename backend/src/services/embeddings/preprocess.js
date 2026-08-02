// Port of internal/vector/embed/preprocess.go. IMPORTANT: any change here that shifts
// output for unchanged flags MUST bump PREPROCESS_VERSION in config.js (folds into the
// generation fingerprint).

const reReplyPreamble = /^On [^\n]+wrote:\s*\n(?:>+[ \t]?.*\n?)+/gm;
const reSigDelim = /\n--\s*\n[\s\S]*$/;
const reQuoteLine = /^>+[ \t]?.*\n?/gm;
const reStyleBlock = /<style[^>]*>.*?<\/style>/gis;
const reScriptBlock = /<script[^>]*>.*?<\/script>/gis;
const reHTMLTag = /<\/?[a-z][a-zA-Z0-9-]*(?:\s+[a-zA-Z_:][a-zA-Z0-9_:.-]*\s*=\s*(?:"[^"]{0,400}"|'[^']{0,400}'|[^\s>"']{1,400}))*\s*\/?>/g;
const reDataURI = /data:[a-zA-Z0-9./+-]{0,128};base64,[A-Za-z0-9+/]+={0,2}/gi;
const reBase64Blob = /[A-Za-z0-9+]{200,}={0,2}/g;
const reBase64BlobWithSlash = /[A-Za-z0-9+/]{300,}={0,2}/g;
const reURL = /https?:\/\/[^\s"'<>)]+/g;
const reTrailingHWS = /[ \t]+$/gm;
const reMultiNewline = /\n{3,}/g;
const reHorizontalRun = /[ \t]{2,}/g;

const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  'utm_name', 'utm_brand', 'utm_social', 'fbclid', 'gclid', 'dclid', 'gbraid',
  'wbraid', 'msclkid', 'yclid', 'twclid', 'mc_cid', 'mc_eid', 'ml_subscriber',
  '_hsenc', '_hsmi', 'hsctatracking', 'vero_conv', 'vero_id', 'ck_subscriber_id',
  '_branch_match_id', 'ref', 'ref_src', 's_cid', 'icid', 'spm',
]);

// Compact analogue of html.UnescapeString: the named entities seen in body_text prose
// plus numeric (decimal/hex) references. PREPROCESS_VERSION pins this behavior.
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", nbsp: ' ',
  copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—',
  ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
};
function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, ent) => {
    if (ent[0] === '#') {
      const cp = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      if (Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff) { try { return String.fromCodePoint(cp); } catch { return m; } }
      return m;
    }
    const v = NAMED_ENTITIES[ent];
    return v !== undefined ? v : m;
  });
}

function stripTrackingParams(s) {
  return s.replace(reURL, (raw) => {
    let trailing = '';
    while (raw.length && '.,;:!?)]'.includes(raw[raw.length - 1])) {
      trailing = raw[raw.length - 1] + trailing;
      raw = raw.slice(0, -1);
    }
    let u;
    try { u = new URL(raw); } catch { return raw + trailing; }
    if (!u.host) return raw + trailing;
    let dropped = false;
    for (const k of [...u.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(k.toLowerCase())) { u.searchParams.delete(k); dropped = true; }
    }
    if (!dropped) return raw + trailing;
    return u.toString() + trailing;
  });
}

function capToRunes(s, maxRunes) {
  // Cap s to maxRunes code points without materializing a full array for huge inputs.
  let count = 0, u16 = 0;
  for (const ch of s) {
    if (count >= maxRunes) return { text: s.slice(0, u16), truncated: true };
    count++; u16 += ch.length;
  }
  return { text: s, truncated: false };
}

export function preprocess(subject, body, maxChars, cfg = {}) {
  let s = String(body).replace(/\r\n/g, '\n');
  let bodyTruncated = false;

  if (cfg.stripBase64) {
    s = s.replace(reDataURI, ' ').replace(reBase64Blob, ' ').replace(reBase64BlobWithSlash, ' ');
  }
  if (cfg.maxBodyRunes > 0) {
    const capped = capToRunes(s, cfg.maxBodyRunes);
    s = capped.text; bodyTruncated = capped.truncated;
  }
  if (cfg.stripHTML) {
    s = s.replace(reStyleBlock, ' ').replace(reScriptBlock, ' ').replace(reHTMLTag, ' ');
    s = decodeEntities(s);
  }
  if (cfg.stripURLTracking) s = stripTrackingParams(s);
  if (cfg.stripQuotes) s = s.replace(reReplyPreamble, '').replace(reQuoteLine, '');
  if (cfg.stripSignatures) s = s.replace(reSigDelim, '');
  if (cfg.collapseWhitespace) {
    s = s.replace(reTrailingHWS, '').replace(reHorizontalRun, ' ').replace(reMultiNewline, '\n\n');
  }
  s = s.trim();

  const prefix = subject ? `Subject: ${subject}\n\n` : '';
  const combined = prefix + s;

  if (maxChars <= 0) return { text: combined, truncated: bodyTruncated };
  const cps = Array.from(combined);
  if (cps.length <= maxChars) return { text: combined, truncated: bodyTruncated };
  return { text: cps.slice(0, maxChars).join(''), truncated: true };
}
