// Tokenizer and feature extractor for the antispam classifier (v0.2).
//
// Pure functions: no I/O, no DB. Converts an email into the bag-of-words
// token list plus the binary/continuous flag features consumed by the
// Multinomial Naive Bayes model (spamModel.js) and persisted at mark time
// (spam_training_log.token_counts / flag_features, migration 0048).
//
// Design reference: .hermes/design/spam-classifier-v0.2.md §6.1

import { createHash } from 'node:crypto';
import { Parser } from 'htmlparser2';
import { parseAuthResults } from './spamParser.js';
import { STOP_WORDS, STOP_WORDS_DEFAULT } from './stopWords.js';

// File extensions associated with executable code (shared with
// spamRules.js rules ATTACHMENT_EXECUTABLE / ATTACHMENT_DOUBLE_EXT).
export const EXECUTABLE_EXTENSIONS = new Set([
  // Windows executables
  'exe', 'scr', 'msi', 'com', 'cpl', 'hta', 'pif', 'gadget',
  // Scripts (Windows)
  'js', 'jse', 'vbs', 'vbe', 'wsf', 'wsh', 'ps1', 'psm1', 'bat', 'cmd',
  // Macros
  'docm', 'xlsm', 'pptm', 'dotm', 'xlsb', 'xlam',
  // Java
  'jar', 'jnlp', 'class',
  // Linux/Mac
  'sh', 'bash', 'ksh', 'csh', 'zsh', 'command',
  // App bundles
  'app', 'dmg', 'pkg', 'apk',
  // Compiled scripting
  'pyc', 'pyo', 'rb', 'pl',
]);

// Union of every language's stop-words. v0.2 does not run language
// detection: a token that is a stop-word in ANY supported language is
// dropped, which is safe (stop-words never discriminate spam from ham)
// and keeps the tokenizer dependency-free.
const ALL_STOP_WORDS = new Set([
  ...STOP_WORDS_DEFAULT,
  ...Object.values(STOP_WORDS).flatMap(set => [...set]),
]);

// Word-ish run: Unicode letters + digits + underscore. Unlike \w, \p{L}
// covers Cyrillic and other non-ASCII scripts (i18n requirement).
const WORD_RE = /[\p{L}\p{N}_]+/gu;

// CJK ideographs are segmented per character (no word boundaries in
// Chinese); every other token is kept whole.
const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf]/u;

const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;

const MIN_TOKEN_LENGTH = 2;
const MAX_TOKEN_LENGTH = 30;

/**
 * Strip HTML to visible text using htmlparser2 (already a backend
 * dependency). Script/style/head contents are dropped.
 *
 * @param {string} html
 * @returns {string} visible text, whitespace-collapsed
 */
export function cleanText(rawBody) {
  if (!rawBody) return '';
  // Fast path: no HTML tags at all.
  if (!/<[a-z/!]/i.test(rawBody)) {
    return collapseWhitespace(decodeEntities(rawBody));
  }
  // Lazy-load the streaming parser only when needed.
  const parts = [];
  let skipDepth = 0;
  const parser = new Parser({
    onopentag(name) {
      if (SKIP_TAGS.has(name.toLowerCase())) skipDepth += 1;
    },
    onclosetag(name) {
      if (SKIP_TAGS.has(name.toLowerCase()) && skipDepth > 0) skipDepth -= 1;
    },
    ontext(text) {
      if (skipDepth === 0) parts.push(text);
    },
  }, { decodeEntities: true });
  parser.write(rawBody);
  parser.end();
  return collapseWhitespace(parts.join(' '));
}

const SKIP_TAGS = new Set(['script', 'style', 'head', 'title', 'noscript', 'template']);

function collapseWhitespace(text) {
  return text.replace(/\s+/g, ' ').trim();
}

function decodeEntities(text) {
  // Covers the common cases; htmlparser2 handles the rest on the HTML path.
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'");
}

/**
 * Tokenize an email into a bag-of-words array.
 *
 * @param {Object} message
 *   { subject: string, body: string (plain), bodyHtml?: string }
 *   Subject tokens are weighted ~x1.5 by duplication (subject is the most
 *   discriminative field; the design doc's "x1.5 via duplicazione" is
 *   implemented as subject appearing twice in the token stream).
 * @returns {string[]} tokens (lowercase, stop-word-free, length-capped)
 */
export function tokenize(message) {
  const subject = cleanText(message?.subject || '');
  const body = message?.body
    ? cleanText(message.body)
    : message?.bodyHtml
      ? cleanText(message.bodyHtml)
      : '';

  const tokens = [];
  // Subject weighted x2 (equivalent to the x1.5 duplication in the design;
  // discrete tokens cannot encode 1.5x, so subject appears twice).
  pushTokenRuns(tokens, `${subject} ${subject}`);
  pushTokenRuns(tokens, body);

  // URL-host tokens: the host of any URL in the body is a token itself
  // (e.g. bit.ly, tinyurl.com), independent of the words around it.
  for (const url of body.match(URL_RE) || []) {
    const host = extractUrlHost(url);
    if (host) tokens.push(normalizeToken(host));
  }

  return tokens.filter(Boolean);
}

function pushTokenRuns(out, text) {
  for (const raw of text.match(WORD_RE) || []) {
    const token = normalizeToken(raw);
    if (token) out.push(token);
  }
}

// Lowercase; segment CJK runs per character; enforce length bounds;
// drop stop-words, pure-numeric tokens, and single chars.
export function normalizeToken(raw) {
  let token = raw.toLowerCase();
  if (CJK_RE.test(token)) {
    // Split a CJK run into individual ideographs ("你好" -> ["你", "好"]).
    const chars = [...token].filter(ch => !/[a-z0-9_]/i.test(ch));
    if (chars.length === 0) return null;
    token = chars[0];
  }
  if (token.length < MIN_TOKEN_LENGTH || token.length > MAX_TOKEN_LENGTH) {
    // A single CJK ideograph is a valid token: one character = one word in
    // Chinese, unlike space-delimited scripts.
    if (!(token.length === 1 && CJK_RE.test(token))) return null;
  }
  if (/^[\p{N}]+$/u.test(token)) return null; // pure numeric
  if (ALL_STOP_WORDS.has(token)) return null;
  return token;
}

function extractUrlHost(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    const m = /^https?:\/\/([^/]+)/i.exec(url);
    return m ? m[1].toLowerCase().replace(/^www\./, '') : null;
  }
}

/**
 * Extract the binary/continuous flag features for a message.
 *
 * @param {Object} message
 *   { subject, from?, replyTo?, headers?, attachments? }
 *   - headers: raw header lines (array) or lowercase-name map (see spamParser)
 *   - attachments: [{ filename?, contentType? }]
 * @returns {Object} flag feature object (schema of spam_training_log.flag_features)
 */
export function extractFlagFeatures(message) {
  const auth = parseAuthResults(message?.headers || []);

  // dkim_pass / spf_pass / dmarc_pass: 1 on pass, 0 on fail-like results,
  // null when the header is absent (excluded from scoring, §6.1).
  const authFlags = {};
  for (const method of ['dkim', 'spf', 'dmarc']) {
    const value = auth[method];
    authFlags[`${method}_pass`] = value === null ? null : value === 'pass' ? 1 : 0;
  }

  const subject = message?.subject || '';
  const attachments = Array.isArray(message?.attachments) ? message.attachments : [];

  const letters = (subject.match(/\p{L}/gu) || []).length;
  const upper = (subject.match(/\p{Lu}/gu) || []).length;

  const fromDomain = extractEmailDomain(message?.from);
  const replyToDomain = extractEmailDomain(message?.replyTo);

  return {
    ...authFlags,
    has_attachment: attachments.length > 0 ? 1 : 0,
    attachment_is_executable: attachments.some(a => {
      const ext = attachmentExtension(a);
      return ext !== null && EXECUTABLE_EXTENSIONS.has(ext);
    }) ? 1 : 0,
    all_caps_subject_ratio: letters > 0 ? upper / letters : 0,
    from_equals_reply_to_mismatch:
      fromDomain && replyToDomain && fromDomain !== replyToDomain ? 1 : 0,
  };
}

// Normalize an email address ("Display Name" <user+tag@Sub.Example.com>)
// down to its lowercase domain, stripping +tags and leading dots.
function extractEmailDomain(address) {
  if (!address) return null;
  const text = String(address);
  // Last <...> wins (RFC 5322 address in angle brackets).
  const angle = /<([^<>]+)>/.exec(text);
  const addr = (angle ? angle[1] : text).trim();
  const at = addr.lastIndexOf('@');
  if (at < 0) return null;
  const domain = addr.slice(at + 1).toLowerCase();
  return domain || null;
}

function attachmentExtension(attachment) {
  const filename = attachment?.filename || attachment?.name;
  if (filename) {
    const base = String(filename).trim();
    const lastDot = base.lastIndexOf('.');
    if (lastDot > 0 && lastDot < base.length - 1) {
      return base.slice(lastDot + 1).toLowerCase();
    }
  }
  const ct = attachment?.contentType || '';
  const mimeExt = /^\s*application\/(x-)?(exe|msdownload|vnd\.ms-)/i.test(ct)
    ? 'exe' : null;
  return mimeExt;
}

/**
 * Stable fingerprint of a message's tokens + flags, used to dedupe
 * re-classification calls (design §11.5).
 *
 * @param {Object} message — same shape as tokenize() + extractFlagFeatures()
 * @returns {string} hex sha-256
 */
export function tokenFingerprint(message) {
  const tokens = tokenize(message);
  const flags = extractFlagFeatures(message);
  const canonical = JSON.stringify({ t: [...tokens].sort(), f: flags });
  return createHash('sha256').update(canonical).digest('hex');
}
