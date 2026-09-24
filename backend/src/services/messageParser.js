import { Parser } from 'htmlparser2';

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
// Extract visible text from an HTML body with a real streaming parser (htmlparser2).
// It is linear by construction — a state machine with no backtracking — so unlike the
// former tag/comment/style/entity regex chain it has no ReDoS surface (see #285/#287/#288,
// where two regex passes each froze the sync loop on crafted bodies). The parser skips
// non-content elements, decodes entities natively, and inserts a space at every element
// boundary so words never merge across block tags. Invisible "preheader killer" runs are
// dropped inline and whitespace-only nodes collapse to one space, so the visible-character
// cap (not raw length) is never exhausted by filler; the cap plus chunked feeding bound
// work on multi-MB bodies. Note: an unclosed <style>/<script> is raw-text-to-EOF per the
// HTML spec (a browser renders nothing after it), so any trailing visible text is dropped —
// matching how the message actually renders, unlike the old head-first regex strip.
const SNIPPET_SKIP_TAGS = new Set(['script', 'style', 'head', 'title', 'noscript']);
const SNIPPET_VISIBLE_CAP = 260; // stop after this many visible chars — comfortably over the 200-char snippet

function extractHtmlSnippetText(html) {
  let out = '';
  let skipDepth = 0;
  let visible = 0;
  let done = false;
  const invisible = new RegExp(INVISIBLE_CHARS_RE.source, 'g');
  const addSeparator = () => { if (out && !/\s$/.test(out)) out += ' '; };

  const parser = new Parser({
    onopentag(name) { if (SNIPPET_SKIP_TAGS.has(name)) { skipDepth++; return; } if (!skipDepth) addSeparator(); },
    onclosetag(name) { if (SNIPPET_SKIP_TAGS.has(name)) { if (skipDepth) skipDepth--; return; } if (!skipDepth) addSeparator(); },
    ontext(text) {
      if (skipDepth || done) return;
      const clean = text.replace(invisible, '');
      if (!clean) return;
      if (/^\s*$/.test(clean)) { addSeparator(); return; } // collapse whitespace-only runs (incl. de-filler'd text)
      out += clean;
      visible += clean.replace(/\s+/g, '').length;
      if (visible >= SNIPPET_VISIBLE_CAP) done = true;
    },
  }, { decodeEntities: true, lowerCaseTags: true });

  try {
    const CHUNK = 65536;
    for (let i = 0; i < html.length && !done; i += CHUNK) parser.write(html.slice(i, i + CHUNK));
    parser.end();
  } catch { /* be robust: return whatever was extracted before any parser error */ }
  return out;
}

// Build a plain-text snippet from an HTML body. Extraction is done by the parser above;
// only the post-extraction text cleanup stays as regex — ##marker## placeholders, residual
// invisibles, decorative divider runs, and whitespace collapse — all operating on already
// extracted visible text (bounded, linear).
export function buildSnippetFromHtml(html) {
  return extractHtmlSnippetText(html)
    // Strip ##marker## template placeholders emitted by some marketing tools
    // (UPS, Epsilon) that don't fully render before sending.
    .replace(/##[^#]*##/g, '')
    .replace(INVISIBLE_CHARS_RE, '')
    // Drop decorative divider runs ("====", "----") used as visual separators.
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
      const bytes = enc.toUpperCase() === 'Q'
        ? Buffer.from(
          text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))),
          'binary',
        )
        : Buffer.from(text, 'base64');
      // An encoded-word's charset may carry a language tag: =?utf-8*en?Q?...?= (RFC 2231 §5).
      return decodeEncodedWordBytes(bytes, String(charset).split('*')[0]);
    } catch { return match; }
  });
}

// An RFC 2047 encoded-word names its own charset, and that charset is frequently not UTF-8:
// ISO-8859-1 and windows-1252 are still common from older mailers, and Scandinavian and
// Central European senders hit them constantly. Decoding those bytes as UTF-8 turns every
// non-ASCII character into U+FFFD, which is what #454 reported.
function decodeEncodedWordBytes(bytes, charset) {
  const label = String(charset || '').trim().toLowerCase() || 'utf-8';
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    // An unknown or bogus label (x-unknown, unknown-8bit, a plain typo). Same policy as raw
    // header bytes: prefer UTF-8, fall back to windows-1252 only when UTF-8 comes back
    // damaged, so this degrades to wrong-but-readable rather than to U+FFFD.
    return decodeBytesPreferUtf8(bytes);
  }
}

// Reused rather than constructed per call: parseRawHeaders runs for every message during
// sync, and decodeHeaderBytes calls this once per header line. decode() is stateless when
// not streaming, so sharing an instance is safe.
const UTF8_DECODER = new TextDecoder('utf-8'); // utf-8 exists in every Node build
// windows-1252 needs ICU. Node ships full ICU by default and the runtime image has it, but
// this is self-hosted software and a small-icu build must not fail to boot over a fallback
// decoder, so its absence is tolerated and simply disables the fallback.
const WINDOWS_1252_DECODER = (() => {
  try {
    return new TextDecoder('windows-1252');
  } catch {
    return null;
  }
})();
const REPLACEMENT_CHAR = '\uFFFD';

// Prefer UTF-8, and only reinterpret as windows-1252 when UTF-8 comes back damaged. Every
// byte is representable in windows-1252, so this degrades to wrong-but-readable rather than
// to a row of U+FFFD.
function decodeBytesPreferUtf8(bytes) {
  const utf8 = UTF8_DECODER.decode(bytes);
  if (!utf8.includes(REPLACEMENT_CHAR) || !WINDOWS_1252_DECODER) return utf8;
  return WINDOWS_1252_DECODER.decode(bytes);
}

// Header bytes are meant to be ASCII, with anything else carried in RFC 2047 encoded-words.
// Plenty of senders ignore that and put raw 8-bit bytes in a Subject or a display name.
// Decoding those as UTF-8 destroys them before encoded-word decoding ever runs, producing
// the same replacement characters as #454 by a different route.
//
// The choice is made per line rather than per block. Applying it to the whole block let one
// sender's stray 8-bit byte decide how every other header was read, so a block holding a
// genuinely UTF-8 subject alongside one latin1 display name turned that subject into
// mojibake: a worse result than the single replacement character it replaced. A UTF-8
// sequence never contains 0x0A, so splitting on it cannot cut one in half.
function decodeHeaderBytes(buf) {
  const out = [];
  let start = 0;
  for (let i = 0; i <= buf.length; i++) {
    if (i !== buf.length && buf[i] !== 0x0A) continue;
    out.push(decodeBytesPreferUtf8(buf.subarray(start, i)));
    if (i < buf.length) out.push('\n');
    start = i + 1;
  }
  return out.join('');
}

export function parseRawHeaders(buf) {
  if (!buf) return {};
  const text = Buffer.isBuffer(buf) ? decodeHeaderBytes(buf) : String(buf);
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
  if (Buffer.isBuffer(headers)) return decodeHeaderBytes(headers);
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

// Headers an MTA/mailbox uses to record the address a message was actually delivered
// to (BCC, catch-all, forwarded alias) — may be absent from To/Cc entirely.
const DELIVERY_HEADERS = ['delivered-to', 'x-delivered-to', 'x-original-to', 'envelope-to'];
// Sender-controlled input persisted per message; capped like subject/snippet.
const MAX_DELIVERY_ADDRESSES = 50;

export function parseDeliveryAddresses(parsedHeaders) {
  const emails = new Set();
  for (const header of DELIVERY_HEADERS) {
    const value = parsedHeaders?.[header];
    if (!value) continue;
    for (const line of value.split(/\r?\n/)) {
      for (const { email } of parseMailboxList(line)) {
        const normalized = email.trim().toLowerCase();
        if (normalized) emails.add(normalized);
        if (emails.size >= MAX_DELIVERY_ADDRESSES) return [...emails];
      }
    }
  }
  // Alias-forwarding services record the alias the message was sent to in their own header
  // (e.g. X-33Mail-Original-To); Delivered-To only shows the user's real mailbox. Taken only
  // when the message is a genuine wrapper of that service -- see detectAliasForwarder (#475).
  const forwarded = detectAliasForwarderFromHeaders(parsedHeaders);
  if (forwarded?.alias && emails.size < MAX_DELIVERY_ADDRESSES) emails.add(forwarded.alias);
  return [...emails];
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

// ─── Alias-forwarding services (#475) ────────────────────────────────────────────────
// Alias services re-wrap every message they forward: From becomes the service's own address,
// the real sender survives only as text inside the display name, and the service replaces the
// original List-Unsubscribe with its own (on every message, transactional mail included). Read
// naively, the whole mailbox classifies as newsletter/bulk and the receiving alias is lost.
//
// The display name is sender-controlled text, so it is only ever interpreted when BOTH hold:
//   1. the envelope From address is on the service's own domain, and
//   2. the message carries the service's marks: its recipient header or its display-name pattern.
// A normal message whose display name imitates the pattern is never unwrapped, and the derived
// sender is stored in separate fields -- From itself is never replaced.
//
// 33Mail sets no header with the original sender; its only carrier is the display name
// ("Stripe 'billing@stripe.com' via 33Mail"). It does set X-33Mail-Original-To (the alias) and a
// Sender header equal to From, so #366's distinct-Sender "via" path does not fire for it.
const ALIAS_FORWARDERS = [
  {
    id: '33mail',
    label: '33Mail',
    domain: '33mail.com',                     // From: sender@mailer<N>.33mail.com
    recipientHeader: 'x-33mail-original-to',  // the alias the message was sent to
  },
];

// Headers a partial IMAP header fetch must include for forwarder detection to work.
export const ALIAS_FORWARDER_HEADERS = ['from', ...ALIAS_FORWARDERS.map(f => f.recipientHeader)];

const MAX_FORWARDER_NAME = 998; // RFC 5322 line limit; longer names are not a forwarder wrapper
const FORWARDER_QUOTES = new Set(["'", '"', '\u2018', '\u2019']);

function emailDomain(email) {
  const at = typeof email === 'string' ? email.lastIndexOf('@') : -1;
  return at >= 0 ? email.slice(at + 1).trim().toLowerCase() : '';
}

function onDomain(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

function isPlainEmail(value) {
  if (!value || /\s/.test(value)) return false;
  const parts = value.split('@');
  return parts.length === 2 && parts[0].length > 0 && parts[1].includes('.')
    && !parts[1].startsWith('.') && !parts[1].endsWith('.');
}

// "Stripe 'billing@stripe.com' via 33Mail" -> { name: 'Stripe', email: 'billing@stripe.com' }
// Linear string scan, no regex backtracking over sender-controlled input.
function parseForwarderDisplayName(name, service) {
  if (typeof name !== 'string' || !name || name.length > MAX_FORWARDER_NAME) return null;
  let text = name.replace(/\s+/g, ' ').trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) text = text.slice(1, -1).trim();
  const suffix = ` via ${service.label}`.toLowerCase();
  if (!text.toLowerCase().endsWith(suffix)) return null;
  text = text.slice(0, -suffix.length).trimEnd();
  if (!text || !FORWARDER_QUOTES.has(text[text.length - 1])) return null;
  let open = -1;
  for (let i = text.length - 2; i >= 0; i--) {
    if (FORWARDER_QUOTES.has(text[i])) { open = i; break; }
  }
  if (open < 0) return null;
  const email = text.slice(open + 1, -1).trim().toLowerCase();
  if (!isPlainEmail(email)) return null;
  return { name: text.slice(0, open).trim(), email };
}

// Returns { service, label, originalName, originalEmail, alias } for a genuine wrapper of a known
// alias-forwarding service, otherwise null. originalEmail is null when the service's recipient
// header is present but the display name does not carry the original sender.
export function detectAliasForwarder({ fromEmail, fromName, headers } = {}) {
  const host = emailDomain(fromEmail);
  if (!host) return null;
  const service = ALIAS_FORWARDERS.find(f => onDomain(host, f.domain));
  if (!service) return null;

  const original = parseForwarderDisplayName(fromName, service);
  const recipientValue = headers?.[service.recipientHeader];
  const alias = recipientValue ? (parseMailboxList(String(recipientValue).split(/\r?\n/)[0])[0]?.email || null) : null;
  // Mail FROM the service itself (account notices, its own newsletter) carries neither mark
  // and is left alone.
  if (!original && !alias) return null;

  return {
    service: service.id,
    label: service.label,
    originalName: original ? original.name : null,
    originalEmail: original ? original.email : null,
    alias,
  };
}

// Same, from a parsed header map (From header instead of the IMAP envelope).
export function detectAliasForwarderFromHeaders(h) {
  const from = h?.from;
  if (!from) return null;
  const mailbox = parseMailboxList(String(from).split(/\r?\n/)[0])[0];
  if (!mailbox) return null;
  return detectAliasForwarder({ fromEmail: mailbox.email, fromName: mailbox.name, headers: h });
}

// True when every URI in a List-Unsubscribe value points at the given domain.
function listUnsubscribeOnlyOn(value, domain) {
  if (!value) return false;
  const uris = [...String(value).matchAll(/<([^<>]*)>/g)].map(m => m[1].trim()).filter(Boolean);
  if (!uris.length) return false;
  return uris.every((uri) => {
    if (/^mailto:/i.test(uri)) return onDomain(emailDomain(uri.slice(7).split('?')[0]), domain);
    try {
      return onDomain(new URL(uri).hostname.toLowerCase(), domain);
    } catch {
      return false;
    }
  });
}

// Removes a forwarder's own artifacts before header-based classification: its List-Unsubscribe
// (only when it points solely at the service, so an original header is never dropped) and the
// wrapper From, replaced by the original sender for the From-based checks (noreply). Headers of
// the original sender that survive forwarding (List-Id, Auto-Submitted, platform headers) stay
// and decide the category. Returns the input unchanged for anything that is not a wrapper.
export function unwrapForwarderHeaders(h) {
  const forwarded = detectAliasForwarderFromHeaders(h);
  if (!forwarded) return h;
  const service = ALIAS_FORWARDERS.find(f => f.id === forwarded.service);
  const out = { ...h };
  if (listUnsubscribeOnlyOn(out['list-unsubscribe'], service.domain)) {
    delete out['list-unsubscribe'];
    delete out['list-unsubscribe-post'];
  }
  if (forwarded.originalEmail) {
    out.from = forwarded.originalName
      ? `${forwarded.originalName} <${forwarded.originalEmail}>`
      : forwarded.originalEmail;
  }
  return out;
}

export function detectBulkFromParsedHeaders(h) {
  if (!h) return false;
  h = unwrapForwarderHeaders(h);
  if (h['list-unsubscribe'] || h['list-id'] || h['list-post']) return true;
  const prec = (h['precedence'] || '').toLowerCase();
  return prec === 'bulk' || prec === 'list';
}

// Returns 'newsletter' | 'promotion' | 'automated' | null.
// null means no header signal found — caller decides 'social' or 'primary'.
// Does NOT check social domains (caller supplies those).
export function detectCategoryFromHeaders(h) {
  if (!h) return null;

  // Alias-forwarding services (#475) — like the developer-platform block below, this has to
  // run before the generic newsletter check: the service adds its own List-Unsubscribe to every
  // message it forwards, so it is stripped here and the original sender's headers decide.
  h = unwrapForwarderHeaders(h);

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

  // RFC 5322 Sender / IMAP ENVELOPE sender (entry[3]): the mailbox that actually submitted the
  // message. Servers default ENVELOPE sender to From when the Sender header is absent, so only
  // treat it as meaningful when its address differs from From — the genuine "on behalf of" / "via"
  // case (mailing lists, send-as platforms, some spoofing). See #366.
  const senderAddr = envelope.sender?.[0] || {};
  const senderEmail = senderAddr.address
    || (senderAddr.mailbox && senderAddr.host ? `${senderAddr.mailbox}@${senderAddr.host}` : '');
  const hasDistinctSender = !!senderEmail && senderEmail.toLowerCase() !== fromEmail.toLowerCase();

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
  // Alias-forwarding services (#475): the original sender is derived, sender-controlled text, so
  // it is kept apart from From and shown as a separate, labelled line -- never in place of From.
  const forwarded = detectAliasForwarder({ fromEmail, fromName: fromAddr.name, headers: parsedHeaders });
  const hasForwardedFrom = !!forwarded?.originalEmail;
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
    senderName: hasDistinctSender ? (senderAddr.name || '') : null,
    senderEmail: hasDistinctSender ? senderEmail : null,
    forwardedFromName: hasForwardedFrom ? (forwarded.originalName || '') : null,
    forwardedFromEmail: hasForwardedFrom ? forwarded.originalEmail : null,
    forwardedVia: hasForwardedFrom ? forwarded.label : null,
    to: mapAddrs(envelope.to),
    cc: mapAddrs(envelope.cc),
    replyTo: mapAddrs(envelope.replyTo),
    inReplyTo: envelope.inReplyTo || null,
    references,
    parsedHeaders,
    deliveryAddresses: parseDeliveryAddresses(parsedHeaders),
    date: msg.internalDate || envelope.date || new Date(),
    snippet,
    isRead,
    isStarred,
    hasAttachments,
    flags,
    isBulk: detectBulkFromParsedHeaders(parsedHeaders),
  };
}

// Mirrors walkStructure's classification (imapManager.js) so the paperclip flag
// agrees with the attachment list: an explicit attachment disposition anywhere,
// or a text part carrying a filename alongside an unnamed text part serving as
// the body (an inline .html report or .txt log the sender didn't dispose as an
// attachment). Exported for tests.
export function detectAttachments(structure) {
  if (!structure) return false;
  let explicit = false;
  let namedText = 0;
  let unnamedText = 0;
  const visit = (node) => {
    if (!node) return;
    if (node.disposition === 'attachment') { explicit = true; return; }
    if (node.childNodes?.length) { node.childNodes.forEach(visit); return; }
    const type = (node.type || '').toLowerCase();
    if (type === 'text/plain' || type === 'text/html' || type === 'application/xhtml+xml') {
      if (node.dispositionParameters?.filename || node.parameters?.name) namedText += 1;
      else unnamedText += 1;
    }
  };
  visit(structure);
  return explicit || (namedText > 0 && unnamedText > 0);
}

// ── Calendar invite rendering ────────────────────────────────────────────────
// Outlook "forward meeting" emails are often a single text/calendar part with
// no text/html or text/plain alternative, which used to render as raw
// VCALENDAR source. Renders a readable invite instead: a summary card
// (what/when/where/organizer) followed by the event description, preferring
// Outlook's X-ALT-DESC HTML form of the description when present. The
// returned html goes through the same sanitizer as any email HTML.

// RFC 5545 line unfolding: a line starting with space or tab continues the
// previous line (the leading whitespace char itself is discarded).
function unfoldIcsLines(raw) {
  const lines = [];
  for (const line of String(raw || '').split(/\r?\n/)) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && lines.length) {
      lines[lines.length - 1] += line.slice(1);
    } else {
      lines.push(line);
    }
  }
  return lines;
}

// Splits a content line into name, parameters and value. Parameter values may
// be quoted and contain ':' or ';' (TZID="(UTC-05:00) Eastern Time"), so only
// separators outside quotes count. Returns null for a line with no value.
function parseIcsLine(line) {
  const segments = [];
  let from = 0;
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQuote = !inQuote; continue; }
    if (inQuote || (c !== ';' && c !== ':')) continue;
    segments.push(line.slice(from, i));
    from = i + 1;
    if (c === ':') {
      const [name, ...paramParts] = segments;
      const params = {};
      for (const p of paramParts) {
        const eq = p.indexOf('=');
        if (eq > 0) params[p.slice(0, eq).trim().toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
      }
      return { name: name.trim().toUpperCase(), params, value: line.slice(from) };
    }
  }
  return null;
}

// RFC 5545 TEXT unescaping in a single pass: \n or \N is a line break and \\ \;
// \, are the literal character, so an escaped backslash before "n" stays "\n".
function unescapeIcsText(value) {
  return String(value || '').replace(/\\([nN\\;,])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const ICS_DT_RE = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2}))?/;

function formatIcsTime(h, m) {
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

// "20260901T140000" → "Tuesday, September 1, 2026, 2:00 PM". The wall-clock
// value is shown as-is (the TZID param is appended by the caller); a trailing
// Z is labeled UTC. Date-only values render without a time.
function formatIcsDate(value) {
  const m = ICS_DT_RE.exec(value || '');
  if (!m) return value || '';
  const [, y, mo, d, hh, mm] = m;
  const day = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  const datePart = day.toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC',
  });
  if (hh === undefined) return datePart;
  return `${datePart}, ${formatIcsTime(Number(hh), Number(mm))}${/Z$/i.test(value) ? ' UTC' : ''}`;
}

// The day before a date-only value ("20260902" → "20260901").
function previousIcsDay(value) {
  const m = ICS_DT_RE.exec(value || '');
  if (!m) return value || '';
  const day = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) - 1));
  return day.toISOString().slice(0, 10).replace(/-/g, '');
}

const ICS_METHOD_LABELS = {
  REQUEST: 'Meeting invitation',
  CANCEL: 'Meeting cancelled',
  REPLY: 'Meeting response',
};

// Parses the first VEVENT of an iCalendar text and renders { html, text },
// or null when the input is not a usable VCALENDAR.
export function renderCalendarInvite(ics) {
  if (!/BEGIN:VCALENDAR/i.test(ics || '')) return null;

  const props = Object.create(null);
  let method = '';
  let inEvent = false;
  let eventDone = false;
  let nested = 0; // depth of sub-components (VALARM) inside the VEVENT
  for (const line of unfoldIcsLines(ics)) {
    const prop = parseIcsLine(line);
    if (!prop) continue;
    const { name, params, value } = prop;
    if (name === 'BEGIN' || name === 'END') {
      const component = value.trim().toUpperCase();
      if (component === 'VEVENT') {
        if (name === 'BEGIN') {
          if (eventDone) break;
          inEvent = true;
        } else if (inEvent) {
          inEvent = false;
          eventDone = true;
        }
        nested = 0;
      } else if (inEvent) {
        nested = Math.max(0, nested + (name === 'BEGIN' ? 1 : -1));
      }
      continue;
    }
    if (!inEvent) {
      if (name === 'METHOD' && !method) method = value.trim().toUpperCase();
      continue;
    }
    // A VALARM's properties are not the event's (its DESCRIPTION is usually
    // just "REMINDER"); within the event itself the first occurrence wins.
    if (nested > 0 || name in props) continue;
    props[name] = { value, params };
  }
  if (!eventDone) return null;

  const summary = unescapeIcsText(props.SUMMARY?.value || '').trim();
  const location = unescapeIcsText(props.LOCATION?.value || '').trim();
  const organizerName = unescapeIcsText(props.ORGANIZER?.params?.CN || '').trim();
  const organizerMail = (props.ORGANIZER?.value || '').replace(/^mailto:/i, '').trim();
  const organizer = organizerName
    ? organizerMail ? `${organizerName} <${organizerMail}>` : organizerName
    : organizerMail;

  let when = '';
  const start = props.DTSTART;
  const end = props.DTEND;
  if (start?.value) {
    when = formatIcsDate(start.value);
    const startDt = ICS_DT_RE.exec(start.value);
    const endDt = ICS_DT_RE.exec(end?.value || '');
    if (startDt && endDt && startDt[4] === undefined && endDt[4] === undefined) {
      // All-day events: a date-only DTEND is exclusive, so show through the
      // day before it, and give a one-day event a single date.
      const lastDay = previousIcsDay(end.value);
      if (lastDay > start.value.slice(0, 8)) when += ` – ${formatIcsDate(lastDay)}`;
    } else if (end?.value) {
      const sameDay = start.value.slice(0, 8) === end.value.slice(0, 8);
      when += sameDay && endDt?.[4] !== undefined
        ? ` – ${formatIcsTime(Number(endDt[4]), Number(endDt[5]))}`
        : ` – ${formatIcsDate(end.value)}`;
    }
    // Exchange TZIDs can carry their own parentheses: "(UTC-05:00) Eastern Time".
    const tzid = (start.params?.TZID || '').trim();
    if (tzid) when += tzid.startsWith('(') ? ` ${tzid}` : ` (${tzid})`;
  }

  const methodLabel = ICS_METHOD_LABELS[method] || '';
  const rows = [];
  if (when) rows.push(['When', when]);
  if (location) rows.push(['Where', location]);
  if (organizer) rows.push(['Organizer', organizer]);
  if (!summary && !rows.length) return null;

  const card =
    '<div style="border:1px solid #d0d0d0;border-radius:8px;padding:12px 16px;margin:0 0 16px;font-family:sans-serif">'
    + (methodLabel ? `<div style="font-size:12px;color:#777;margin-bottom:4px">${escapeHtml(methodLabel)}</div>` : '')
    + (summary ? `<div style="font-size:16px;font-weight:600;margin-bottom:8px">${escapeHtml(summary)}</div>` : '')
    + rows.map(([k, v]) => `<div style="font-size:13px;margin:2px 0"><b>${k}:</b> ${escapeHtml(v)}</div>`).join('')
    + '</div>';

  // Outlook ships an HTML form of the description in X-ALT-DESC — prefer it;
  // otherwise render the plain DESCRIPTION preserving its line breaks.
  const altDesc = props['X-ALT-DESC'];
  const altHtml = (altDesc?.params?.FMTTYPE || '').toLowerCase() === 'text/html'
    ? unescapeIcsText(altDesc.value).trim()
    : '';
  const description = unescapeIcsText(props.DESCRIPTION?.value || '').trim();
  const bodyHtml = altHtml
    || (description
      ? `<div style="font-family:sans-serif;font-size:13px;white-space:pre-wrap">${escapeHtml(description)}</div>`
      : '');

  const text = [
    methodLabel,
    summary,
    ...rows.map(([k, v]) => `${k}: ${v}`),
    '',
    description,
  ].filter(Boolean).join('\n');

  return { html: card + bodyHtml, text };
}
