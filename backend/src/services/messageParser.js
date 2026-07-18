// Regex matching invisible / zero-width / filler Unicode chars used by email marketers
// as "preheader killers" to prevent snippet text from leaking into mail-client previews.
// U+00AD soft-hyphen, U+034F combining grapheme joiner, U+200B zero-width space,
// U+200C ZWNJ, U+200D ZWJ, U+200E LTR mark, U+200F RTL mark,
// U+2007 figure space, U+2060 word joiner, U+2061-U+2064 invisible operators,
// U+FEFF BOM / zero-width no-break space.
export const INVISIBLE_CHARS_RE = new RegExp(
  [0x00AD, 0x034F, 0x200B, 0x200C, 0x200D, 0x200E, 0x200F, 0x2007, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0xFEFF]
    .map(n => String.fromCodePoint(n)).join('|'),
  'g'
);

// Named HTML entities commonly found in marketing/transactional email bodies.
// Decoded to their Unicode equivalents so snippets preserve meaning (e.g.
// "Great offer&hellip;" → "Great offer…" instead of "Great offer ").
// Numeric entities (&#8230; &#x2014;) are handled by the regex below; this
// map covers only named references that those regexes do not catch.
const NAMED_ENTITY_MAP = {
  // Punctuation & typography
  hellip: '…', mldr: '…',
  mdash: '—', ndash: '–', minus: '−',
  lsquo: '‘', rsquo: '’', sbquo: '‚',
  ldquo: '“', rdquo: '”', bdquo: '„',
  bull: '•', middot: '·',
  laquo: '«', raquo: '»', lsaquo: '‹', rsaquo: '›',
  // Currency & symbols
  trade: '™', reg: '®', copy: '©', deg: '°', micro: 'µ',
  euro: '€', pound: '£', yen: '¥', cent: '¢',
  times: '×', divide: '÷', plusmn: '±',
  frac12: '½', frac14: '¼', frac34: '¾',
  // Arrows (shipping/tracking emails)
  rarr: '→', larr: '←', uarr: '↑', darr: '↓', harr: '↔',
  // Whitespace variants → single space
  thinsp: ' ', ensp: ' ', emsp: ' ', hairsp: ' ', nnbsp: ' ',
  // Invisible chars → empty (also caught by INVISIBLE_CHARS_RE, belt-and-suspenders)
  shy: '', zwnj: '', zwj: '', lrm: '', rlm: '',
};

// Decode a named HTML entity reference; fall back to a single space for
// unknown entities so they don't litter snippet text with literal &foo;
export function decodeNamedEntity(_, name) {
  const v = NAMED_ENTITY_MAP[name.toLowerCase()];
  return v !== undefined ? v : ' ';
}

// Detect a text/plain part that is actually a raw HTML document — some senders
// put the full HTML body in the text/plain alternative. A document-level opener,
// attribute-bearing tag, or style/script block is definitive; otherwise require
// several closing tags near the start so prose that merely mentions an
// attribute-less tag ("use the <b> element") is not misrouted. Only the head is
// scanned to keep this cheap on large messages.
function looksLikeHtml(text) {
  const head = text.slice(0, 2048);
  if (/^\s*<(?:!doctype|html|head|body)[\s>]/i.test(head)) return true;
  if (/<[a-z][a-z0-9]*\s[^>]*=[^>]*>/i.test(head)) return true;
  if (/<(?:style|script)[\s>]/i.test(head)) return true;
  const closingTags = head.match(/<\/[a-z][a-z0-9]*\s*>/gi);
  return closingTags !== null && closingTags.length >= 3;
}

// Lossy text/plain conversions can retain markup while omitting text that is
// still present in the sibling HTML part.
function isDegenerateText(text) {
  return /<!--/.test(text)
    || /<\/[a-z][a-z0-9:-]*\s*>/i.test(text)
    || /^\s*(?:\(\s*\)|\[\s*\]|<\s*>)/.test(text);
}

// Build a plain-text snippet from either a decoded text/plain or text/html body.
// Single canonical function used by all snippet-generation paths (IMAP sync,
// body prefetch, backfill) so entity handling is identical everywhere.
export function snippetFromBody(text, html) {
  // HTML shipped in the text/plain part must go through the HTML stripper,
  // otherwise the markup itself becomes the "preview" (<!DOCTYPE html ...).
  if (text && looksLikeHtml(text)) {
    const stripped = buildSnippetFromHtml(text);
    if (stripped) return stripped;
    text = '';
  }
  if (html && text && isDegenerateText(text)) {
    const stripped = buildSnippetFromHtml(html);
    if (stripped) return stripped;
  }
  if (text) {
    let cleaned = text
      // Strip [image: alt text] placeholders produced by Google's HTML-to-text converter
      // and some ESPs. These appear at the top of text/plain alternatives for image-heavy
      // marketing emails and produce useless "[image: Banner]" previews.
      .replace(/\[image:[^\]]*\]/gi, '');
    // A declaration separator distinguishes CSS blocks from prose braces. Body
    // text is attacker-controlled and this runs synchronously at ingest, so the
    // pattern must stay linear: the includes() gate skips brace-free bodies
    // outright; the lookbehind only attempts runs from their first character
    // (where the leftmost match always starts, so behavior is unchanged)
    // instead of re-scanning from every position; the selector scan is capped
    // at 160 characters; and the lookahead finds the separator in one forward
    // pass rather than a backtracking [^{}]*[:;][^{}]* split.
    if (cleaned.includes('{')) {
      cleaned = cleaned.replace(/(?<=^|[\s{}<>])[^\s{}<>][^{}<>]{0,160}\{(?=[^{}]*[:;])[^{}]*\}/g, ' ');
    }
    cleaned = cleaned
      // Converted plain-text parts can retain comments or closing markup even
      // when no HTML sibling is available for a cleaner fallback.
      .replace(/<!--[\s\S]*?(?:-->|$)/gi, ' ')
      .replace(/<\/[a-z][a-z0-9:-]*\s*>/gi, ' ')
      // Strip Markdown-style [label](url) links — ESPs like Klaviyo generate text/plain
      // by converting HTML anchors to Markdown, so the entire body can be link syntax.
      // Must run before the bare-URL pass below: stripping the URL first would leave
      // a dangling "[label]()" that no longer matches this pattern.
      .replace(/\[([^\]\r\n]*)\]\([^)\r\n]*\)/g, '$1')
      // Drop raw link targets — they carry no preview value, the link text does.
      // Covers scheme'd URLs and mailto:, plus protocol-less www. hosts. Bare
      // domains without a scheme ("visit example.com") are prose, not unambiguous
      // links, and are kept. HTML-to-text converters render anchors as
      // "label ( URL )" or "<URL>"; removing the URL here leaves an empty wrapper
      // that the bracket collapse below sweeps up.
      .replace(/(?:https?:\/\/|mailto:)[^\s<>()[\]]+/gi, '')
      .replace(/(?<![\w@.])www\.[^\s<>()[\]]+/gi, '')
      // Entity decoding must precede the bracket collapse: unknown entities decode
      // to a space, which can hollow out a wrapper (e.g. "(&nbsp;)" -> "( )").
      .replace(/&#x([0-9A-Fa-f]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#([0-9]+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
      .replace(/&([a-z][a-z0-9]*);/gi, decodeNamedEntity)
      .replace(INVISIBLE_CHARS_RE, '')
      // Collapse wrappers left empty by the URL/link stripping above (and any
      // pre-existing "()" litter from partially converted bodies).
      .replace(/\(\s*\)|\[\s*\]|<\s*>/g, ' ')
      // Drop standalone runs of Markdown emphasis/divider chars ("**", "____").
      .replace(/(?<=^|\s)[*_]{2,}(?=\s|$)/g, '')
      .replace(/\s+/g, ' ').trim()
      // Whitespace boundaries keep short or inline Markdown and signature
      // syntax intact while removing long runs used only as decoration.
      .replace(/(?<=^|\s)([=_*#~-])\1{3,}(?=\s|$)/g, '')
      .replace(/\s+/g, ' ').trim();
    if (cleaned) return cleaned.substring(0, 200);
    // Text body was entirely image placeholders — fall through to HTML.
  }
  if (html) {
    return buildSnippetFromHtml(html);
  }
  return '';
}

// Strip HTML markup and decode all entities to produce a plain-text snippet.
// Exported so imapManager can use the same logic when building snippets from
// pre-fetched raw HTML bodies (avoiding duplicated, inconsistent entity handling).
export function buildSnippetFromHtml(html) {
  return html
    // Strip the enclosing head first so an unclosed nested style cannot consume
    // visible body content while falling back to the end of the document.
    .replace(/<head\b[^>]*>[\s\S]*?(?:<\/head\s*>|$)/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?(?:<\/style\s*>|$)/gi, '')
    .replace(/<script\b[^>]*>[\s\S]*?(?:<\/script\s*>|$)/gi, '')
    // Strip HTML comments (including MSO conditional comments) before tag
    // stripping — otherwise dangling --> fragments and comment content leak
    // into the snippet text (e.g. UPS ##varLangText1## template markers sit
    // inside comments and survive tag-only regex stripping).
    .replace(/<!--[\s\S]*?(?:-->|$)/gi, '')
    // Strip ##marker## template placeholders emitted by some marketing tools
    // (UPS, Epsilon) that don't fully render before sending.
    .replace(/##[^#]*##/g, '')
    .replace(/<(?:[^>"']|"[^"]*"|'[^']*')+>/g, ' ')
    // A tag with no closing angle bracket bypasses the tag matcher and would
    // otherwise become literal preview text through the end of the body.
    .replace(/<\/?[a-z][a-z0-9:-]*(?:\s+[\s\S]*)?$/gi, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#x([0-9A-Fa-f]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#([0-9]+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z][a-z0-9]*);/gi, decodeNamedEntity)
    .replace(INVISIBLE_CHARS_RE, '')
    .replace(/(?<=^|\s)([=_*#~-])\1{3,}(?=\s|$)/g, '')
    .replace(/\s+/g, ' ').trim().substring(0, 200);
}

// Walk bodyStructure to find the best text part for a snippet.
// Prefers text/plain; falls back to text/html.
function findSnippetPart(structure) {
  if (!structure) return null;
  const type = (structure.type || '').toLowerCase();

  if (structure.childNodes?.length) {
    let plainPart = null;
    let htmlPart = null;
    for (const child of structure.childNodes) {
      const found = findSnippetPart(child);
      if (!found) continue;
      if (found.type === 'text/plain') {
        if (!plainPart) plainPart = found;
      } else if (!htmlPart) {
        htmlPart = found;
      }
    }
    if (plainPart) {
      return {
        ...plainPart,
        // A nested multipart/alternative owns the most relevant fallback;
        // otherwise use the HTML sibling discovered at this level.
        htmlFallback: plainPart.htmlFallback || htmlPart || undefined,
      };
    }
    return htmlPart;
  }

  const disposition = (structure.disposition || '').toLowerCase();
  if (disposition === 'attachment') return null;

  if (type === 'text/plain' || type === 'text/html') {
    return {
      part: structure.part || '1',
      type,
      encoding: (structure.encoding || '').toLowerCase(),
      charset: structure.parameters?.charset || 'utf-8',
      htmlFallback: undefined,
    };
  }
  return null;
}

// Decode a body part Buffer using the given transfer encoding and charset.
// Mirrors the same function in imapManager.js — kept local to avoid a
// circular import (messageParser is imported by imapManager).
function decodeBodyPart(buf, encoding, charset) {
  const enc = (encoding || '').toLowerCase();
  let cs = (charset || 'utf-8').toLowerCase().trim().replace(/^['"]|['"]$/g, '');
  if (!cs || cs === 'us-ascii' || cs === 'ascii') cs = 'utf-8';

  let rawBytes;
  if (enc === 'base64') {
    const b64 = buf.toString('ascii').replace(/\s/g, '');
    try { rawBytes = Buffer.from(b64, 'base64'); } catch { rawBytes = buf; }
  } else if (enc === 'quoted-printable') {
    const cleaned = buf.toString('ascii').replace(/=\r\n/g, '').replace(/=\n/g, '');
    const bytes = [];
    let i = 0;
    while (i < cleaned.length) {
      if (cleaned[i] === '=' && i + 2 < cleaned.length) {
        const hex = cleaned.slice(i + 1, i + 3);
        if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
          bytes.push(parseInt(hex, 16));
          i += 3;
          continue;
        }
      }
      bytes.push(cleaned.charCodeAt(i) & 0xFF);
      i++;
    }
    rawBytes = Buffer.from(bytes);
  } else {
    rawBytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  }

  try {
    return new TextDecoder(cs, { fatal: false }).decode(rawBytes);
  } catch {
    return rawBytes.toString('utf8');
  }
}

// Parse a raw header Buffer (from imapflow's `headers: true`) into a plain object.
// Header names are lowercased. Multiple values for the same header are joined with '\n'.
// Decode RFC 2047 MIME encoded-words (=?charset?Q/B?text?=) in a header string.
// Adjacent encoded words separated only by whitespace are joined per RFC 2047 §6.2.
export function decodeMimeWords(str) {
  if (!str || !str.includes('=?')) return str;
  let s = str;
  let prev;
  do {
    prev = s;
    s = s.replace(/(=\?[^?]+\?[BQbq]\?[^?]*\?=)\s+(=\?[^?]+\?[BQbq]\?[^?]*\?=)/g, '$1$2');
  } while (s !== prev);
  return s.replace(/=\?([^?]+)\?([BQbq])\?([^?]*)\?=/g, (match, charset, enc, text) => {
    try {
      if (enc.toUpperCase() === 'Q') {
        const bytes = text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
        return Buffer.from(bytes, 'binary').toString('utf8');
      }
      return Buffer.from(text, 'base64').toString('utf8');
    } catch { return match; }
  });
}

export function parseRawHeaders(buf) {
  if (!buf) return {};
  const text = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
  const result = {};
  // Headers can be folded (continuation lines start with whitespace)
  const unfolded = text.replace(/\r\n([ \t])/g, ' ').replace(/\n([ \t])/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon < 1) continue;
    const name = line.slice(0, colon).toLowerCase().trim();
    const val = line.slice(colon + 1).trim();
    if (!name) continue;
    result[name] = result[name] ? result[name] + '\n' + val : val;
  }
  return result;
}

// Normalize imapflow header payloads (Buffer, string, Map-like) into a key/value map.
export function parseHeadersInput(headers) {
  if (!headers) return {};
  if (Buffer.isBuffer(headers) || typeof headers === 'string') return parseRawHeaders(headers);
  if (typeof headers === 'object') {
    const result = {};
    if (typeof headers.forEach === 'function') {
      headers.forEach((val, key) => {
        const k = String(key).toLowerCase();
        const v = Array.isArray(val) ? val.join('\n') : String(val);
        result[k] = result[k] ? `${result[k]}\n${v}` : v;
      });
      if (Object.keys(result).length) return result;
    }
    for (const [key, val] of Object.entries(headers)) {
      const k = String(key).toLowerCase();
      const v = Array.isArray(val) ? val.join('\n') : String(val);
      result[k] = result[k] ? `${result[k]}\n${v}` : v;
    }
    if (Object.keys(result).length) return result;
  }
  return parseRawHeaders(String(headers));
}

export function headersToRawString(headers) {
  if (!headers) return '';
  if (Buffer.isBuffer(headers)) return headers.toString('utf8');
  const parsed = parseHeadersInput(headers);
  if (Object.keys(parsed).length) {
    return Object.entries(parsed)
      .flatMap(([k, v]) => v.split('\n').map(line => `${k}: ${line}`))
      .join('\r\n');
  }
  const s = String(headers);
  return s === '[object Object]' ? '' : s;
}

function formatAddressEntry(entry) {
  if (typeof entry === 'string') return decodeMimeWords(entry);
  const email = entry?.email || '';
  const name = entry?.name || '';
  if (name && email) return `"${decodeMimeWords(name)}" <${email}>`;
  return email || decodeMimeWords(name) || '';
}

function parseAddressJson(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Build a best-effort RFC822 header block from stored message metadata.
export function buildHeadersFromMessage(msg) {
  const lines = [];
  const fromEmail = msg.from_email || '';
  const fromName = msg.from_name || '';
  if (fromEmail || fromName) {
    lines.push(`From: ${formatAddressEntry({ name: fromName, email: fromEmail })}`);
  }
  const to = parseAddressJson(msg.to_addresses);
  if (to.length) lines.push(`To: ${to.map(formatAddressEntry).join(', ')}`);
  const cc = parseAddressJson(msg.cc_addresses);
  if (cc.length) lines.push(`Cc: ${cc.map(formatAddressEntry).join(', ')}`);
  const replyTo = parseAddressJson(msg.reply_to);
  if (replyTo.length) lines.push(`Reply-To: ${replyTo.map(formatAddressEntry).join(', ')}`);
  const subject = msg.subject && msg.subject !== '(no subject)' ? decodeMimeWords(msg.subject) : '';
  if (subject) lines.push(`Subject: ${subject}`);
  if (msg.message_id) lines.push(`Message-ID: ${msg.message_id}`);
  if (msg.date) {
    try { lines.push(`Date: ${new Date(msg.date).toUTCString()}`); } catch { /* skip */ }
  }
  if (msg.in_reply_to) lines.push(`In-Reply-To: ${msg.in_reply_to}`);
  if (msg.thread_references) lines.push(`References: ${msg.thread_references}`);
  return lines.join('\r\n');
}

function resolveSubject(envelopeSubject, parsedHeaders) {
  const fromEnvelope = envelopeSubject ? decodeMimeWords(envelopeSubject).trim() : '';
  const fromHeader = parsedHeaders.subject ? decodeMimeWords(parsedHeaders.subject).trim() : '';
  return fromEnvelope || fromHeader || '(no subject)';
}

function parseSingleMailbox(str) {
  const trimmed = decodeMimeWords(str.trim());
  const m = trimmed.match(/^(.+?)\s*<([^>]+)>\s*$/);
  if (m) {
    return {
      name: m[1].replace(/^"|"$/g, '').trim(),
      email: m[2].trim().toLowerCase(),
    };
  }
  const bare = trimmed.match(/^\s*<([^>]+)>\s*$/);
  if (bare) return { name: '', email: bare[1].trim().toLowerCase() };
  if (trimmed.includes('@')) return { name: '', email: trimmed.toLowerCase() };
  return { name: trimmed, email: '' };
}

// Parse a comma-separated RFC 5322 address list (To/Cc/Bcc headers).
export function parseMailboxList(headerValue) {
  if (!headerValue) return [];
  const results = [];
  let current = '';
  let inQuote = false;
  for (let i = 0; i < headerValue.length; i++) {
    const c = headerValue[i];
    if (c === '"') inQuote = !inQuote;
    if (c === ',' && !inQuote) {
      if (current.trim()) results.push(parseSingleMailbox(current));
      current = '';
      continue;
    }
    current += c;
  }
  if (current.trim()) results.push(parseSingleMailbox(current));
  return results.filter(r => r.email);
}

// Fill gaps when IMAP ENVELOPE is incomplete — common for multipart/related Sent copies.
export function enrichParsedMetadata(parsed, {
  accountEmail,
  accountName,
  senderName,
  folderPath,
  sentFolderPath,
} = {}) {
  const isSentFolder = (sentFolderPath && folderPath === sentFolderPath)
    || (typeof folderPath === 'string' && /\bsent\b/i.test(folderPath));

  if (isSentFolder && !parsed.fromEmail && accountEmail) {
    parsed.fromEmail = accountEmail;
    parsed.fromName = parsed.fromName || senderName || accountName || '';
  }

  if ((!parsed.subject || parsed.subject === '(no subject)') && parsed.parsedHeaders?.subject) {
    const subject = decodeMimeWords(parsed.parsedHeaders.subject).trim();
    if (subject) parsed.subject = subject;
  }

  if ((!parsed.to || parsed.to.length === 0) && parsed.parsedHeaders?.to) {
    parsed.to = parseMailboxList(parsed.parsedHeaders.to);
  }

  if ((!parsed.cc || parsed.cc.length === 0) && parsed.parsedHeaders?.cc) {
    parsed.cc = parseMailboxList(parsed.parsedHeaders.cc);
  }

  return parsed;
}

export function detectBulkFromParsedHeaders(h) {
  if (!h) return false;
  if (h['list-unsubscribe'] || h['list-id'] || h['list-post']) return true;
  const prec = (h['precedence'] || '').toLowerCase();
  return prec === 'bulk' || prec === 'list';
}

// Returns 'newsletter' | 'promotion' | 'automated' | null.
// null means no header signal found — caller decides 'social' or 'primary'.
// Does NOT check social domains (caller supplies those).
export function detectCategoryFromHeaders(h) {
  if (!h) return null;

  // Developer platform / issue tracker notifications — must run before the generic
  // newsletter check because services like GitHub set List-ID and Precedence: list
  // on notification emails that are not newsletters.
  if (h['x-github-reason'] || h['x-github-sender'] || h['x-github-delivery'] ||
      h['x-gitlab-project-id'] || h['x-gitlab-pipeline-id'] || h['x-gitlab-noteable-type'] ||
      h['x-linear-team-id'] || h['x-linear-issue-id'] ||
      h['x-jira-fingerprint'] || h['x-atlassian-token'] ||
      h['x-phabricator-sent-this-message'] ||
      h['x-bugzilla-component'] ||
      h['x-sentry-reply-to']) return 'automated';

  // Calendar invites (meeting requests, ICS attachments) → automated.
  // Content-Type can be 'text/calendar' for simple invites or
  // 'multipart/...' containing a calendar part; both cases set the top-level
  // Content-Type to something including 'calendar'.
  const ct = (h['content-type'] || '').toLowerCase();
  if (ct.includes('text/calendar') || ct.includes('application/ics')) return 'automated';

  // Noreply sender addresses → automated. Matches the local part of the
  // From address immediately before the '@' so we don't false-positive on
  // display names like "No Reply Needed <person@company.com>".
  if (/(?:^|[\s<,])(?:noreply|no[-.]reply|donotreply|do[-.]not[-.]reply)@/i.test(h['from'] || '')) {
    return 'automated';
  }

  // Newsletter — RFC mailing list headers (same signals as is_bulk)
  if (h['list-id'] || h['list-unsubscribe'] || h['list-post']) return 'newsletter';
  const prec = (h['precedence'] || '').toLowerCase();
  if (prec === 'bulk' || prec === 'list') return 'newsletter';

  // Promotion — known marketing platform headers
  if (h['x-campaign-id'] || h['x-mailchimp-campaign-id'] ||
      h['x-marketo-track'] || h['x-salesforce-emailid'] ||
      h['x-klaviyo-campaign-id'] || h['x-hubspot-email-id']) return 'promotion';
  const mailer = (h['x-mailer'] || '').toLowerCase();
  if (mailer.includes('mailchimp') || mailer.includes('constant contact') ||
      mailer.includes('klaviyo') || mailer.includes('hubspot') ||
      mailer.includes('marketo') || mailer.includes('sendgrid')) return 'promotion';

  // Automated — transactional / system notifications
  // RFC 3834: Auto-Submitted values other than 'no' indicate automated mail.
  const autoSubmitted = (h['auto-submitted'] || '').toLowerCase().trim();
  if (autoSubmitted && autoSubmitted !== 'no') return 'automated';

  return null;
}

export async function parseMessage(msg) {
  const envelope = msg.envelope || {};
  const flags = msg.flags ? [...msg.flags] : [];

  const fromAddr = envelope.from?.[0] || {};
  // imapflow returns { name, address } — older typedefs showed mailbox+host but
  // that's not what the library actually emits. Fall back to the legacy form too.
  const fromEmail = fromAddr.address
    || (fromAddr.mailbox && fromAddr.host ? `${fromAddr.mailbox}@${fromAddr.host}` : '');
  const fromName = fromAddr.name || fromAddr.mailbox || fromEmail.split('@')[0] || '';

  const mapAddrs = (addrs) => (addrs || []).map(a => ({
    name: a.name || '',
    email: a.address || (a.mailbox && a.host ? `${a.mailbox}@${a.host}` : ''),
  }));

  const isRead = flags.includes('\\Seen');
  const isStarred = flags.includes('\\Flagged');

  // Build snippet from the first available text body part, properly decoded.
  let snippet = '';
  if (msg.bodyParts && msg.bodyParts.size > 0) {
    // Try to identify the correct part and its encoding from bodyStructure
    const partInfo = msg.bodyStructure ? findSnippetPart(msg.bodyStructure) : null;

    let rawBuf = null;
    let encoding = '';
    let charset = 'utf-8';
    let isHtml = false;

    if (partInfo && msg.bodyParts.has(partInfo.part)) {
      rawBuf = msg.bodyParts.get(partInfo.part);
      encoding = partInfo.encoding;
      charset = partInfo.charset || 'utf-8';
      isHtml = partInfo.type === 'text/html';
    } else {
      // Fallback: grab the first available part (may be wrong for multipart)
      for (const [, value] of msg.bodyParts) {
        rawBuf = value;
        break;
      }
    }

    if (rawBuf) {
      try {
        const text = decodeBodyPart(rawBuf, encoding, charset);
        let htmlFallbackText;
        if (!isHtml && partInfo?.htmlFallback && msg.bodyParts.has(partInfo.htmlFallback.part)) {
          const fallback = partInfo.htmlFallback;
          htmlFallbackText = decodeBodyPart(
            msg.bodyParts.get(fallback.part),
            fallback.encoding,
            fallback.charset || 'utf-8'
          );
        }
        // Route through the canonical snippet builders so sync-time snippets get
        // the same link/markup/entity cleanup as body prefetch and backfill.
        snippet = isHtml ? buildSnippetFromHtml(text) : snippetFromBody(text, htmlFallbackText);
      } catch { /* leave snippet empty on parse failure */ }
    }
  }

  // Detect attachments from body structure
  let hasAttachments = false;
  if (msg.bodyStructure) {
    hasAttachments = detectAttachments(msg.bodyStructure);
  }

  const parsedHeaders = parseHeadersInput(msg.headers);
  const references = (() => {
    if (msg.headers && typeof msg.headers.get === 'function') return msg.headers.get('references') || null;
    return parsedHeaders.references || null;
  })();

  return {
    uid: msg.uid,
    messageId: envelope.messageId || null,
    subject: resolveSubject(envelope.subject, parsedHeaders),
    fromName,
    fromEmail,
    to: mapAddrs(envelope.to),
    cc: mapAddrs(envelope.cc),
    replyTo: mapAddrs(envelope.replyTo),
    inReplyTo: envelope.inReplyTo || null,
    references,
    parsedHeaders,
    date: msg.internalDate || envelope.date || new Date(),
    snippet,
    isRead,
    isStarred,
    hasAttachments,
    flags,
    isBulk: detectBulkFromParsedHeaders(parsedHeaders),
  };
}

function detectAttachments(structure) {
  if (!structure) return false;
  if (structure.disposition === 'attachment') return true;
  if (structure.childNodes) {
    return structure.childNodes.some(child => detectAttachments(child));
  }
  return false;
}
