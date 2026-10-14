import sanitizeHtml from 'sanitize-html';
import { parse, serialize, defaultTreeAdapter } from 'parse5';
import { logger } from './logger.js';

// Strip the <head> element from email HTML, preserving any <style> blocks inside it.
//
// Why: sanitize-html's 'discard' mode removes disallowed tags (e.g. <title>) but
// keeps their text content.  Non-whitespace text inside <head> is moved to <body>
// by the HTML5 parser (it treats it as an implicit body-start), so text like
// "Document" or "Buffalo Tech Systems" from a <title> tag renders visibly at the
// top of the email.  Stripping <head> entirely (while rescuing <style> blocks, which
// contain layout CSS) prevents this and has no effect on the visible email content.
//
// MSO conditional comments (<!--[if gte mso 9]>...<![endif]-->) are stripped before
// extracting <style> blocks so that Outlook-only CSS rules (e.g. mso-* properties,
// table layout overrides) are not applied in browser rendering, where they can break
// font sizes, spacing, and colors that the email author tuned for non-Outlook clients.
// Case-insensitive indexOf for an ASCII needle, searched in the string itself. Searching a
// toLowerCase() copy instead gives wrong positions once the text holds a character whose lowercase
// is longer (İ becomes two characters): offsets drifted by one per İ, so text was cut at the wrong
// place and a following block could be skipped.
function indexOfCi(str, needle, from) {
  const re = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  re.lastIndex = from;
  const m = re.exec(str);
  return m ? m.index : -1;
}

// Replace every `<tag …>content</tag>` span in linear time. A lazy
// `<tag\b[^>]*>[\s\S]*?</tag>` /g regex is O(n²) on hostile email HTML on TWO axes:
// the `[^>]*>` opener backtracks futilely when a tag has no `>`, and the lazy
// `[\s\S]*?` re-scans to end-of-string from every unmatched opener when a close is
// missing. A crafted body of many bare `<head>`/`<style>` froze the render path
// (found by eslint-plugin-redos). Node lacks possessive/atomic quantifiers, so we
// scan by hand: `openNameRe` is a fixed tag-name literal (e.g. /<style\b/gi, linear),
// the opening tag ends at the first `>` (indexOf — same as the quote-unaware `[^>]*>`),
// and content ends at the nearest close (indexOf — same as lazy `[\s\S]*?`). When no
// `>` or close exists at/after an opener, none exists for any later opener either
// (positions only advance), so we stop — exactly what the regex would leave unmatched.
function scanPaired(str, openNameRe, closeLiteral, transform) {
  let out = '';
  let pos = 0;
  let m;
  openNameRe.lastIndex = 0;
  while ((m = openNameRe.exec(str)) !== null) {
    const gt = str.indexOf('>', m.index);
    if (gt === -1) break; // unterminated opening tag — no match, like [^>]*> would fail
    const contentStart = gt + 1;
    const closeIdx = indexOfCi(str, closeLiteral, contentStart);
    if (closeIdx === -1) break;
    const spanEnd = closeIdx + closeLiteral.length;
    out += str.slice(pos, m.index) + transform(str.slice(m.index, contentStart), str.slice(contentStart, closeIdx), str.slice(closeIdx, spanEnd));
    pos = spanEnd;
    openNameRe.lastIndex = spanEnd;
  }
  return out + str.slice(pos);
}

// Rewrites the text of every <style> block, then seals it. The rewrites run on sanitized output and
// delete parts of the CSS (a declaration, a url(), a whole @media block); a deletion joins the text
// on either side of it, and `</` before one with `style` after it made a real end tag, closing the
// block early so whatever followed it in the CSS (tags sanitize-html had only seen as style text:
// <a href="javascript:…">, <form>, <base>) reached the body as markup. Sealing turns any `</style`
// left in the text into `<\/style`, the same characters to CSS and no end tag to the HTML parser.
// An opening `<style` is escaped the same way (`<\style`), so text in an email's own CSS can never
// pass for the dark-scheme block MailFlow appends after it (DARK_STYLE_OPEN, splitDarkScheme).
export function sealStyleText(css) {
  return css.replace(/<(\/?)(style)/gi, '<\\$1$2');
}

function rewriteStyleBlocks(html, rewrite) {
  return scanPaired(html, /<style\b/gi, '</style>', (open, content, close) => open + sealStyleText(rewrite(content)) + close);
}

// Strip MSO-positive conditional comments (<!--[if mso]>…<![endif]-->) linearly,
// preserving <!--[if !mso]> blocks (browser-targeted CSS). Mirrors the old regex
// /<!--\[if(?!\s*!)[^\]]*\]>[\s\S]*?<!\[endif\]-->/gi without its backtracking.
function stripMsoConditionals(hc) {
  const END = '<![endif]-->';
  const openRe = /<!--\[if/gi;
  let out = '';
  let pos = 0;
  let m;
  while ((m = openRe.exec(hc)) !== null) {
    const after = m.index + m[0].length;
    let k = after;
    while (k < hc.length && /\s/.test(hc[k])) k++;
    if (hc[k] === '!') { openRe.lastIndex = after; continue; } // <!--[if !mso]> — keep
    const rb = hc.indexOf(']', after);
    if (rb === -1) break;
    if (hc[rb + 1] !== '>') { openRe.lastIndex = after; continue; } // ']' not immediately '>' — no match
    const endIdx = indexOfCi(hc, END, rb + 2);
    if (endIdx === -1) break;
    out += hc.slice(pos, m.index);
    pos = endIdx + END.length;
    openRe.lastIndex = pos;
  }
  return out + hc.slice(pos);
}

export function stripEmailHead(html) {
  if (!html) return html;
  return scanPaired(html, /<head\b/gi, '</head>', (_open, headContent) => {
    const noMso = stripMsoConditionals(headContent);
    // Rescue <style> blocks (layout CSS) from the head; drop everything else.
    let styles = '';
    scanPaired(noMso, /<style\b/gi, '</style>', (open, content, close) => { styles += open + content + close; return ''; });
    return styles;
  });
}


function upgradeUrl(url) {
  return typeof url === 'string' && url.startsWith('http://') ? 'https://' + url.slice(7) : url;
}

// Normalise an anchor href value to an absolute https/mailto/tel URL, or return
// null if the href cannot be safely resolved (relative paths, fragments, etc.).
// Returns null for hrefs that would resolve against the mailflow origin in a
// same-origin srcdoc iframe — callers should omit the href attribute entirely.
function normalizeHref(href) {
  if (!href) return null;
  const h = href.trim();
  if (!h) return null;
  if (/^https:\/\//i.test(h)) return h;
  if (/^http:\/\//i.test(h)) return 'https://' + h.slice(7);
  if (/^(mailto:|cid:|tel:|sms:)/i.test(h)) return h;
  if (h.startsWith('//')) return 'https:' + h;
  // Fragment, root-relative, path-relative, query-only — unsafe to resolve in iframe
  if (/^[#/?.]/i.test(h)) return null;
  // Explicitly block dangerous schemes even if they somehow reach this point
  if (/^(javascript|data|vbscript):/i.test(h)) return null;
  // Bare domain (e.g. "benchmade.com", "www.example.com/path") — no scheme, has a dot
  if (/^[a-z0-9]/i.test(h) && h.includes('.')) return 'https://' + h;
  return null;
}

// Rewrite anchor hrefs in already-cached HTML — applied at serve-time for emails
// stored before href normalisation was added to sanitizeEmail().
export function rewriteAnchorHrefs(html) {
  if (!html) return html;
  return html.replace(
    /(<a\b[^>]*?\s)href=(["'])([^"']*)\2/gi,
    (match, pre, q, raw) => {
      const normalized = normalizeHref(raw);
      if (normalized === null) return pre; // drop the href attribute
      if (normalized === raw) return match;
      return `${pre}href=${q}${normalized}${q}`;
    }
  );
}

// eBay's imageser service (svcs.ebay.com/imageser) wraps real product images
// behind a session-authenticated rendering layer.  Cross-site iframe requests
// never carry eBay cookies (SameSite policy), so imageser returns 1 byte instead
// of the actual image.  The real URL is always in the `imageUrl` query parameter
// and is publicly accessible from i.ebayimg.com.  Extract and use it directly.
function unwrapEbayImgUrl(url) {
  if (!url || !url.includes('svcs.ebay.com/imageser')) return url;
  try {
    const u = new URL(url);
    if (u.hostname === 'svcs.ebay.com' && u.pathname.startsWith('/imageser/')) {
      const direct = u.searchParams.get('imageUrl');
      if (direct && direct.startsWith('https://')) return direct;
    }
  } catch { /* invalid URL — return as-is */ }
  return url;
}

// Rewrite any eBay imageser src URLs remaining in already-cached HTML.
// Applied at serve-time for emails stored before this fix was deployed.
// The src attribute value in stored HTML has & escaped as &amp;, so we decode
// it before parsing the URL.
export function rewriteEbayImageserUrls(html) {
  if (!html || !html.includes('svcs.ebay.com/imageser')) return html;
  return html.replace(
    /(<img\b[^>]*?\s)src=(["'])(https:\/\/svcs\.ebay\.com\/imageser\/[^"']*)\2/gi,
    (match, pre, q, url) => {
      try {
        const cleanUrl = url.replace(/&amp;/g, '&');
        const u = new URL(cleanUrl);
        if (u.hostname === 'svcs.ebay.com' && u.pathname.startsWith('/imageser/')) {
          const direct = u.searchParams.get('imageUrl');
          if (direct && direct.startsWith('https://')) return `${pre}src=${q}${direct}${q}`;
        }
      } catch { /* invalid URL — leave src unchanged */ }
      return match;
    }
  );
}

// Upgrade http:// → https:// inside CSS url() expressions.
// Handles both quoted (url('http://...'), url("http://...")) and unquoted (url(http://...)) forms.
function upgradeStyleUrls(style) {
  if (!style) return style;
  return style.replace(/url\(\s*(['"]?)http:\/\//gi, (_, q) => `url(${q}https://`);
}

// Strip external http/https url() expressions from <style> block CSS at sanitize time.
// This prevents CSS-based exfiltration (loading pixel beacons or fonts) regardless of
// the user's remote image blocking preference.  data: and cid: URIs are left intact.
function stripExternalStyleBlockUrls(html) {
  if (!html) return html;
  return rewriteStyleBlocks(html, stripExternalCssUrls);
}

// Mirrors /url\s*\(\s*(['"]?)https?:\/\/[^)]*\1\s*\)/gi without its backtracking: from every
// candidate, [^)]* ran on to the next `)`, or to the end of the block, and backtracked through
// it, so a crafted <style> held the event loop for seconds. Candidates that reach the same `)`
// can differ in quote, so each one is tested against it, but that `)` and the last non-space
// character before it are found only once.
function stripExternalCssUrls(css) {
  const urlRe = /url\s*\(\s*(['"]?)https?:\/\//gi;
  let out = '';
  let pos = 0;
  let paren = -1;
  let lastNonSpace = -1;
  let m;
  while ((m = urlRe.exec(css)) !== null) {
    const valueStart = urlRe.lastIndex;
    if (paren < valueStart) {
      paren = css.indexOf(')', valueStart);
      if (paren === -1) break;
      lastNonSpace = paren - 1;
      while (lastNonSpace >= valueStart && /\s/.test(css[lastNonSpace])) lastNonSpace--;
    }
    const quote = m[1];
    if (quote && (lastNonSpace < valueStart || css[lastNonSpace] !== quote)) continue;
    out += css.slice(pos, m.index) + 'url()';
    pos = paren + 1;
    urlRe.lastIndex = pos;
  }
  return out + css.slice(pos);
}

// Post-process sanitized HTML to upgrade http:// URLs inside <style> blocks.
// sanitize-html only transforms attributes, not element text content, so <style>
// block CSS must be handled separately after sanitization.
function upgradeStyleBlocks(html) {
  if (!html) return html;
  return rewriteStyleBlocks(html, content => content.replace(/url\(\s*(['"]?)http:\/\//gi, (_, q) => `url(${q}https://`));
}

// The sender's dark design (#228). @media (prefers-color-scheme: dark) blocks used to be deleted,
// because they fired against the forced-white frame (white text on white). They are moved instead,
// each whole, into one style element at the end of the stored body that is switched off
// (media="not all"), so the stored body stays a light email. splitDarkScheme below reads that back
// out; the body route sends it as its own field and the frame applies it only when it shows the
// message dark. The dark condition becomes one that always holds, so a block's other conditions
// (a max-width, say) still apply. Nothing here parses or rewrites selectors.
export const DARK_SCHEME_STYLE_ATTR = 'data-mf-dark-scheme';
// Left in the body when the sender asked to stay light (color-scheme: only light), so the reader
// never renders that message dark.
export const LIGHT_ONLY_MARKER = '<!--mf-light-only-->';
const LIGHT_ONLY_RE = /\b(?:only\s+light|light\s+only)\b/i;

// Strip dark-mode CSS from a <style> block's text content.
// Targets @media (prefers-color-scheme: dark) blocks (moved into `moved`, see above), Outlook
// dark-mode attribute selectors, and properties that invert or override the forced-light background.
function stripDarkModeCss(css, moved = [], flags = {}) {
  // Move @media (prefers-color-scheme: dark) { ... } blocks out.
  let out = stripDarkMediaBlocks(css, moved);
  // Remove rules scoped to Outlook dark-mode attribute selectors
  // (e.g. [data-ogsc], [data-ogsb]).
  out = stripOutlookDarkRules(out);
  // Strip color-scheme declarations — the iframe meta tag controls this instead. One that asks
  // to stay light is remembered first.
  out = out.replace(/\bcolor-scheme\s*:[^;!}]+;?/gi, (decl) => {
    if (LIGHT_ONLY_RE.test(decl)) flags.lightOnly = true;
    return '';
  });
  // Strip filter:invert(...) — used to simulate dark mode by inverting the page,
  // which breaks rendering on our forced-white background.
  out = stripInvertFilters(out);
  return out;
}

// The three scanners below mirror the old regexes
//   /@media\b[^{]*prefers-color-scheme\s*:\s*dark[^{]*\{(?:[^{}]|\{[^{}]*\})*\}/gi
//   /\[[^\]]*data-og[^\]]*\][^{]*\{[^}]*\}/gi
//   /\bfilter\s*:\s*invert\([^)]*\)[^;]*;?/gi
// without their backtracking. From every candidate, the leading [^{]*, [^\]]* or [^)]*
// ran on to the next `{`, `]` or `)`, or to the end of the block, and backtracked
// through it, so a crafted <style> of a few tens of KB held the event loop for seconds
// to minutes, and sanitizeEmail runs when sync prefetches a new message. Candidates
// that reach the same `{` or `]` share its outcome, so after one fails the scan resumes
// past it; once the `{`, `]` or `)` a candidate needs is missing, every later candidate
// lacks it too, so the scan stops.
function stripDarkMediaBlocks(css, moved = []) {
  const atMedia = /@media\b/gi;
  let out = '';
  let pos = 0;
  let m;
  while ((m = atMedia.exec(css)) !== null) {
    const open = css.indexOf('{', atMedia.lastIndex);
    if (open === -1) break;
    const prelude = css.slice(atMedia.lastIndex, open);
    const dark = /prefers-color-scheme\s*:\s*dark/i.test(prelude);
    const end = dark ? mediaBlockEnd(css, open) : -1;
    if (end === -1) { atMedia.lastIndex = open; continue; }
    moved.push(`@media${prelude.replace(/prefers-color-scheme\s*:\s*dark/gi, 'min-width: 0px')}${css.slice(open, end)}`);
    out += css.slice(pos, m.index);
    pos = end;
    atMedia.lastIndex = end;
  }
  return out + css.slice(pos);
}

// Index just past the `}` closing the block opened at `open`, allowing one level of
// nested blocks as the old pattern did, or -1 if it is unterminated or nests deeper.
function mediaBlockEnd(css, open) {
  let depth = 1;
  for (let i = open + 1; i < css.length; i++) {
    if (css[i] === '{') {
      if (depth === 2) return -1;
      depth = 2;
    } else if (css[i] === '}') {
      if (depth === 1) return i + 1;
      depth = 1;
    }
  }
  return -1;
}

function stripOutlookDarkRules(css) {
  let out = '';
  let pos = 0;
  let from = 0;
  for (;;) {
    const lb = css.indexOf('[', from);
    if (lb === -1) break;
    const rb = css.indexOf(']', lb + 1);
    if (rb === -1) break;
    if (!/data-og/i.test(css.slice(lb + 1, rb))) { from = rb + 1; continue; }
    const open = css.indexOf('{', rb + 1);
    if (open === -1) break;
    const close = css.indexOf('}', open + 1);
    if (close === -1) break;
    out += css.slice(pos, lb);
    pos = close + 1;
    from = pos;
  }
  return out + css.slice(pos);
}

function stripInvertFilters(css) {
  const invertRe = /\bfilter\s*:\s*invert\(/gi;
  let out = '';
  let pos = 0;
  let m;
  while ((m = invertRe.exec(css)) !== null) {
    const paren = css.indexOf(')', invertRe.lastIndex);
    if (paren === -1) break;
    // The declaration ends at its ';' or at the '}' closing its rule, whichever comes first; the
    // '}' stays. Looking only for ';' ran across the end of a rule written without one
    // (img{filter:invert(1)}) and deleted the rules after it up to the next ';'.
    const semi = css.indexOf(';', paren + 1);
    const brace = css.indexOf('}', paren + 1);
    out += css.slice(pos, m.index);
    if (brace !== -1 && (semi === -1 || brace < semi)) pos = brace;
    else pos = semi === -1 ? css.length : semi + 1;
    invertRe.lastIndex = pos;
  }
  return out + css.slice(pos);
}

// Whether the raw message asks to stay light in a <meta name="color-scheme"> (or the older
// supported-color-schemes). The head is gone by the time style blocks are processed, so this reads
// the input. Each <meta is examined only up to its own '>', so crafted markup stays linear.
function declaresLightOnly(html) {
  if (!html) return false;
  const metaRe = /<meta\b/gi;
  let m;
  while ((m = metaRe.exec(html)) !== null) {
    const end = html.indexOf('>', metaRe.lastIndex);
    if (end === -1) return false;
    const tag = html.slice(m.index, end);
    if (/\bname\s*=\s*["']?(?:color-scheme|supported-color-schemes)\b/i.test(tag) && LIGHT_ONLY_RE.test(tag)) return true;
    metaRe.lastIndex = end;
  }
  return false;
}

// The other half of the format stripDarkModeStyleBlocks writes into a stored body: the email's own
// HTML, the sender's dark CSS, and whether it asked to stay light, as separate values. The body
// route sends them as separate fields, so the reader never matches markup and the HTML a reply,
// forward or print reuses is the sanitized email alone. Writer and reader live together here so
// the format cannot drift.
const DARK_STYLE_OPEN = `<style ${DARK_SCHEME_STYLE_ATTR} media="not all">`;
export function splitDarkScheme(stored) {
  if (typeof stored !== 'string') return { html: stored, darkCss: null, lightOnly: false };
  const lightOnly = stored.includes(LIGHT_ONLY_MARKER);
  let html = lightOnly ? stored.split(LIGHT_ONLY_MARKER).join('') : stored;
  let darkCss = null;
  const start = html.lastIndexOf(DARK_STYLE_OPEN);
  const end = start === -1 ? -1 : html.indexOf('</style>', start);
  if (end !== -1) {
    darkCss = html.slice(start + DARK_STYLE_OPEN.length, end) || null;
    html = html.slice(0, start) + html.slice(end + '</style>'.length);
  }
  return { html, darkCss: lightOnly ? null : darkCss, lightOnly };
}

// The stored body as an email again, for HTML that leaves MailFlow straight from the server.
export const withoutDarkScheme = (stored) => splitDarkScheme(stored).html;

function stripDarkModeStyleBlocks(html, { lightOnly = false } = {}) {
  if (!html) return html;
  const moved = [];
  const flags = { lightOnly };
  const out = rewriteStyleBlocks(html, content => stripDarkModeCss(content, moved, flags));
  if (flags.lightOnly) return LIGHT_ONLY_MARKER + out;
  if (!moved.length) return out;
  // The moved blocks get the same clean-up as the rest, so an invert() in the sender's dark CSS
  // cannot flip the colors back once it is switched on.
  const darkCss = stripInvertFilters(stripOutlookDarkRules(moved.join('\n')).replace(/\bcolor-scheme\s*:[^;!}]+;?/gi, ''));
  return `${out}<style ${DARK_SCHEME_STYLE_ATTR} media="not all">${sealStyleText(darkCss)}</style>`;
}

// Re-serialize through the HTML5 tree builder first so the markup sanitize-html sees
// has the structure a browser would build. htmlparser2 does not implement the spec's
// error recovery: a stray </td> closes the nearest <td> on the whole stack, even one in
// an outer table, and a </head> placed after </body> made stripEmailHead treat the
// entire document as head.
//
// parse5 sets no limits, and this runs on every body that sync prefetches. Markup can make
// it far costlier than its size: the serializer recurses once per level, the spec re-creates
// every open formatting element, attributes and all, after each block, each foster-parented
// node or repeated <body> costs a scan, and the tokenizer compares every attribute name with
// all earlier ones on its tag. So large bodies skip the pass, a tag with too many attributes
// skips it too, and every tree operation is charged against a budget proportional to the
// input. Past the depth cap or the budget the body is sanitized as received, as it was before.
const MAX_HTML5_LENGTH = 128 * 1024; // Gmail clips mail past 102 KB, so senders stay under it
const MAX_TREE_DEPTH = 512; // Chromium's parser caps its tree depth at 512 as well
// The tokenizer's duplicate check is quadratic per tag and runs before the tree adapter, so
// the budget cannot stop it: one tag with 26,000 attributes in 128 KB took 1.2 s here.
// Real mail has a handful of attributes per tag.
const MAX_ATTRIBUTES_PER_TAG = 500;
const TOO_COSTLY = new Error('HTML5 tree too deep or too large');

const isSpace = (c) => c === ' ' || c === '\n' || c === '\t' || c === '\f' || c === '\r';
const isAsciiAlpha = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');

// The tokenizer states a tag goes through, as far as starting attributes goes (the spec's
// tag-name to attribute-value states; self-closing folds into BEFORE_ATTR).
const TAG_NAME = 0, BEFORE_ATTR = 1, ATTR_NAME = 2, AFTER_ATTR_NAME = 3, BEFORE_VALUE = 4;
const DOUBLE_QUOTED = 5, SINGLE_QUOTED = 6, UNQUOTED = 7, END_TAG_OPEN = 8, TAG_STATES = 9, TAG_END = -1, NEW_ATTR = -2;

// One character of a tag, from state `s`: the next state, TAG_END, or NEW_ATTR when the
// character starts an attribute (the state is then ATTR_NAME).
function stepTag(s, c) {
  switch (s) {
    case TAG_NAME: return c === '>' ? TAG_END : isSpace(c) || c === '/' ? BEFORE_ATTR : TAG_NAME;
    case BEFORE_ATTR: return c === '>' ? TAG_END : isSpace(c) || c === '/' ? BEFORE_ATTR : NEW_ATTR;
    case ATTR_NAME: return c === '>' ? TAG_END : isSpace(c) ? AFTER_ATTR_NAME : c === '/' ? BEFORE_ATTR : c === '=' ? BEFORE_VALUE : ATTR_NAME;
    case AFTER_ATTR_NAME: return c === '>' ? TAG_END : isSpace(c) ? AFTER_ATTR_NAME : c === '/' ? BEFORE_ATTR : c === '=' ? BEFORE_VALUE : NEW_ATTR;
    case BEFORE_VALUE: return c === '>' ? TAG_END : isSpace(c) ? BEFORE_VALUE : c === '"' ? DOUBLE_QUOTED : c === "'" ? SINGLE_QUOTED : UNQUOTED;
    case DOUBLE_QUOTED: return c === '"' ? BEFORE_ATTR : DOUBLE_QUOTED;
    case SINGLE_QUOTED: return c === "'" ? BEFORE_ATTR : SINGLE_QUOTED;
    case END_TAG_OPEN: return TAG_NAME; // the `/` of `</x`
    default: return c === '>' ? TAG_END : isSpace(c) ? BEFORE_ATTR : UNQUOTED;
  }
}

// Whether some tag in `html` could have more than MAX_ATTRIBUTES_PER_TAG attributes, in one
// linear pass. Where a tag starts depends on parse5's tree builder: inside <style>, <script>,
// <textarea> or a comment, `<x` is text, except in <svg> or <math>, where <style> holds tags.
// Rather than follow that, every `<` or `</` before a letter is taken as a possible tag, and
// each is followed with the tokenizer's own attribute rules, which do not depend on where the
// tag is. parse5's real tags are among them, so this never counts fewer attributes than parse5
// does; text that only looks like a tag can only overcount, which skips the pass. Possible
// tags in the same state behave alike from then on, so one counter per state (the highest)
// is enough, and the pass is O(length * TAG_STATES).
function hasTagWithTooManyAttributes(html) {
  let counts = new Array(TAG_STATES).fill(-1);
  let next = new Array(TAG_STATES);
  for (let i = 0; i < html.length; i++) {
    const c = html[i];
    next.fill(-1);
    for (let s = 0; s < TAG_STATES; s++) {
      if (counts[s] < 0) continue;
      let to = stepTag(s, c);
      let count = counts[s];
      if (to === TAG_END) continue;
      if (to === NEW_ATTR) {
        if (++count > MAX_ATTRIBUTES_PER_TAG) return true;
        to = ATTR_NAME;
      }
      if (count > next[to]) next[to] = count;
    }
    // A possible tag starts here. Every candidate already open still reads each character,
    // so none is skipped: an end tag's `/` goes through END_TAG_OPEN.
    if (c === '<' && isAsciiAlpha(html[i + 1])) next[TAG_NAME] = Math.max(next[TAG_NAME], 0);
    else if (c === '<' && html[i + 1] === '/' && isAsciiAlpha(html[i + 2])) next[END_TAG_OPEN] = Math.max(next[END_TAG_OPEN], 0);
    [counts, next] = [next, counts];
  }
  return false;
}

function toBrowserTree(html) {
  if (!html || html.length > MAX_HTML5_LENGTH) return html;
  if (hasTagWithTooManyAttributes(html)) {
    logger.warn(`sanitizeEmail: a tag has more than ${MAX_ATTRIBUTES_PER_TAG} attributes; sanitizing the HTML as received`);
    return html;
  }
  let depth = 0;
  let budget = 8 * html.length + 4096;
  const spend = (cost) => { if ((budget -= cost) < 0) throw TOO_COSTLY; };
  const treeAdapter = {
    ...defaultTreeAdapter,
    createElement(tagName, namespaceURI, attrs) {
      let size = 2 * tagName.length + 5;
      for (const { name, value } of attrs) size += name.length + value.length + 4;
      spend(size);
      return defaultTreeAdapter.createElement(tagName, namespaceURI, attrs);
    },
    // The default adapter scans the parent's children, or the recipient's attributes, here.
    insertBefore(parentNode, newNode, referenceNode) {
      spend(parentNode.childNodes.length);
      defaultTreeAdapter.insertBefore(parentNode, newNode, referenceNode);
    },
    insertTextBefore(parentNode, text, referenceNode) {
      spend(parentNode.childNodes.length);
      defaultTreeAdapter.insertTextBefore(parentNode, text, referenceNode);
    },
    detachNode(node) {
      if (node.parentNode) spend(node.parentNode.childNodes.length);
      defaultTreeAdapter.detachNode(node);
    },
    adoptAttributes(recipient, attrs) {
      spend(recipient.attrs.length + attrs.length);
      defaultTreeAdapter.adoptAttributes(recipient, attrs);
    },
    onItemPush() { if (++depth > MAX_TREE_DEPTH) throw TOO_COSTLY; },
    onItemPop() { depth--; },
  };
  try {
    return serialize(parse(html, { treeAdapter }));
  } catch (err) {
    // Past a cap, a stack overflow, or anything else parse5 throws on some unusual body:
    // sanitize the body as received rather than fail to show it.
    logger.warn(`sanitizeEmail: ${err?.message || err}; sanitizing the HTML as received`);
    return html;
  }
}

// Sanitize HTML email body — permissive but safe.
// A URL attribute as the browser reads it: the URL standard drops every tab and line break inside
// a URL and trims control characters and spaces from its ends. Left in, `ht&#x0A;tps://…` hid an
// image from remote-image blocking and the proxy, which match the URL as written, while the
// browser still fetched it from the sender (in the composer, where the app's CSP allows it).
function asBrowserUrl(value) {
  // eslint-disable-next-line no-control-regex -- the C0 controls the URL standard trims
  return String(value).replace(/[\t\n\r]/g, '').replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, '');
}

export function sanitizeEmail(html, { preserveDraftSignature = false } = {}) {
  const sanitized = sanitizeHtml(stripEmailHead(toBrowserTree(html)), {
    allowVulnerableTags: true,
    allowedTags: [
      'div','span','p','br','hr',
      'h1','h2','h3','h4','h5','h6',
      'ul','ol','li','dl','dt','dd',
      'table','thead','tbody','tfoot','tr','th','td','caption','colgroup','col',
      'a','img','figure','figcaption',
      'strong','b','em','i','u','s','del','ins','sub','sup','small','big',
      'blockquote','pre','code','tt','kbd','samp',
      'center','font','strike',
      // A lifted draft signature is inserted into the app DOM, where a stylesheet
      // can affect the whole application rather than an isolated email iframe.
      ...(preserveDraftSignature ? [] : ['style']),
    ],
    allowedAttributes: {
      ...(preserveDraftSignature ? { div: ['data-mailflow-signature'] } : {}),
      '*': ['style', 'class', 'id', 'align', 'valign', 'width', 'height',
             'bgcolor', 'color', 'border', 'cellpadding', 'cellspacing',
             'colspan', 'rowspan', 'nowrap', 'dir', 'lang',
             // 'background' is an old HTML attribute used on table/td/tr for
             // background images — common in marketing emails.
             'background'],
      'a': ['href', 'name', 'target', 'title', 'rel'],
      'img': ['src', 'alt', 'width', 'height', 'border',
              // srcset is required for responsive images — many senders
              // (LinkedIn, etc.) use srcset as the primary image source and
              // put a 1×1 tracking pixel in src as the fallback.  Without
              // srcset, only the tracker is visible.
              'srcset', 'sizes',
              'loading', 'decoding'],
      'table': ['summary'],
      'td': ['abbr', 'axis', 'headers', 'scope'],
      'th': ['abbr', 'axis', 'headers', 'scope'],
    },
    transformTags: {
      // A browser never renders <title>, but discarding the tag keeps its text. The HTML5
      // pass moves a <title> into <body> when junk ends the head early, or when a whole
      // document is embedded in a forward, so stripEmailHead no longer catches it.
      'title': (tagName) => ({ tagName, attribs: {}, text: '' }),
      // Ensure all links open safely.  Also normalise bare-domain hrefs like
      // "benchmade.com" → "https://benchmade.com" so they work as expected in
      // the sandboxed iframe, and strip relative/fragment hrefs that would
      // otherwise resolve to the mailflow origin.
      'a': (tagName, attribs) => {
        const out = { ...attribs, rel: 'noopener noreferrer' };
        if ('href' in out) {
          const normalized = normalizeHref(out.href);
          if (normalized === null) delete out.href;
          else out.href = normalized;
        }
        return { tagName, attribs: out };
      },
      // Upgrade http:// → https:// for image sources and inline style url() refs.
      // Many marketing emails still use plain-http image URLs which are blocked as
      // mixed content on an https host, causing images to silently fail.
      'img': (tagName, attribs) => {
        const out = { ...attribs };
        if (out.src)    out.src    = unwrapEbayImgUrl(upgradeUrl(asBrowserUrl(out.src)));
        // Simple regex replacement avoids split(',') corrupting data: URIs that
        // contain commas (e.g. data:image/png;base64,abc 2x).
        if (out.srcset) out.srcset = out.srcset.replace(/\bhttp:\/\//g, 'https://');
        if (out.background) out.background = upgradeUrl(asBrowserUrl(out.background));
        if (out.style) out.style = upgradeStyleUrls(out.style);
        // Defer loading of remote images; skip cid:/data: which are already local.
        const isLocal = out.src && /^(cid:|data:)/i.test(out.src);
        if (!isLocal) out.loading = 'lazy';
        out.decoding = 'async';
        return { tagName, attribs: out };
      },
      // Wildcard: upgrade background attribute and inline style url() for all
      // elements that don't have a specific transform above.  sanitize-html uses
      // the specific-tag transform when one exists and falls back to '*', so this
      // fires for <table>, <td>, <tr>, <div>, <body>, etc. — all the elements
      // that marketing emails (like eBay's) use for table-based background images
      // and CSS background-image declarations.
      '*': (tagName, attribs) => {
        const out = { ...attribs };
        if (out.background) out.background = upgradeUrl(asBrowserUrl(out.background));
        if (out.style) out.style = upgradeStyleUrls(out.style);
        return { tagName, attribs: out };
      },
    },
    allowedSchemes: ['http', 'https', 'mailto', 'cid'],
    allowedSchemesByTag: {
      img: ['http', 'https', 'cid', 'data'],
    },
    disallowedTagsMode: 'discard',
  });

  // Upgrade http:// URLs in <style> block CSS content — sanitize-html's transformTags
  // only handles attributes, so CSS url() inside <style> blocks must be fixed afterward.
  // Then move the sender's dark-mode CSS aside (see stripDarkModeStyleBlocks) so it cannot override
  // the forced-light rendering.
  return stripDarkModeStyleBlocks(upgradeStyleBlocks(stripExternalStyleBlockUrls(sanitized)), { lightOnly: declaresLightOnly(html) });
}

// The text/plain part of a message written in the composer: its body or its signature, as HTML.
// sanitize-html keeps only the block tags, and returns well-formed markup with every entity
// decoded except the few it escapes itself, so what is left is line breaks at block ends, HTML's
// whitespace collapsing (except inside <pre>), and those escapes. Stripping every tag with
// sanitize-html alone left that escaping in the text (`&lt;` for `<`) and ran paragraphs together.
const TEXT_BLOCK_TAGS = ['p', 'div', 'br', 'li', 'ul', 'ol', 'tr', 'td', 'th', 'table', 'blockquote', 'pre', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr'];
const TEXT_ESCAPES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'" };
const BLOCK = 'p|div|li|ul|ol|tr|table|blockquote|pre|h[1-6]';
// Placeholders while tags become lines: a block boundary (a line break unless the text is already
// at the start of a line, so nested and adjacent blocks give one) and an empty block (a blank
// line, which is how the composer writes an empty line).
const BOUNDARY = '\u0001';
const EMPTY_LINE = '\u0002';

export function composeHtmlToText(html) {
  if (!html) return '';
  // The placeholders are removed from the input first, so text cannot collide with them.
  // eslint-disable-next-line no-control-regex -- BOUNDARY and EMPTY_LINE, as above
  const input = String(html).replace(/[\u0001\u0002]/g, '');
  const blocks = sanitizeHtml(input, { allowedTags: TEXT_BLOCK_TAGS, allowedAttributes: {} });
  return blocks
    // HTML's whitespace collapses (not &nbsp;, which keeps the spacing typed), and goes entirely
    // next to a block tag; <pre> keeps its own.
    .split(/(<pre>[\s\S]*?<\/pre>)/)
    .map((part, i) => (i % 2 ? part : part
      .replace(/[ \t\n\r\f]+/g, ' ')
      .replace(new RegExp(` ?(<\\/?(?:${BLOCK}|br|hr)\\s*\\/?>) ?`, 'g'), '$1')))
    .join('')
    .replace(new RegExp(`<(p|div|h[1-6])>(?:<br\\s*\\/?>)?<\\/\\1>`, 'g'), BOUNDARY + EMPTY_LINE + BOUNDARY)
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<hr\s*\/?>/g, `${BOUNDARY}---${BOUNDARY}`)
    .replace(/<li>/g, `${BOUNDARY}- `)
    .replace(new RegExp(`<\\/?(?:${BLOCK})>`, 'g'), BOUNDARY)
    // Cells of a row stay on its line.
    .replace(/<\/t[dh]>/g, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&(?:amp|lt|gt|quot|#39|apos);/g, entity => TEXT_ESCAPES[entity])
    .replace(/\u00a0/g, ' ')
    /* eslint-disable no-control-regex -- BOUNDARY and EMPTY_LINE are control characters on purpose;
       they were removed from the input above, so they cannot collide with what was written. */
    .replace(/\u0001+/g, BOUNDARY)
    .replace(/^\u0001|(\n)\u0001/g, '$1')
    .replace(/\u0001/g, '\n')
    .replace(/\u0002/g, '')
    /* eslint-enable no-control-regex */
    // Trailing spaces per line. A regex like /[ \t]+\n/ rescans a long run of spaces from each of
    // its characters: 100,000 &nbsp; took 4 s on the event loop.
    .split('\n').map(line => line.trimEnd()).join('\n')
    .trim();
}

// Sanitize user-authored compose body HTML — allows rich formatting and inline
// images (data: or https:) but strips scripts and event handlers.
export function sanitizeComposeBody(html) {
  if (!html) return html;
  return sanitizeHtml(html, {
    allowedTags: [
      'a', 'b', 'strong', 'i', 'em', 'u', 's', 'del',
      'p', 'br', 'div', 'span', 'img',
      'ul', 'ol', 'li',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr',
      'blockquote', 'pre', 'code',
      'table', 'thead', 'tbody', 'tr', 'th', 'td',
      'font', 'center',
    ],
    allowedAttributes: {
      '*': ['style', 'class'],
      'a': ['href', 'target', 'rel'],
      'img': ['src', 'alt', 'width', 'height', 'title'],
      'font': ['color', 'size', 'face'],
      'td': ['colspan', 'rowspan', 'align', 'valign', 'width', 'height', 'bgcolor'],
      'th': ['colspan', 'rowspan', 'align', 'valign'],
      'table': ['width', 'cellpadding', 'cellspacing', 'border', 'align', 'bgcolor'],
      'code': ['class'],
    },
    // Every scheme normalizeHref can emit must be listed. Anything it produces that is not
    // allowed gets its href stripped while the <a> survives, which renders as a link but
    // does nothing when clicked.
    allowedSchemes: ['https', 'mailto', 'tel', 'sms', 'cid'],
    allowedSchemesByTag: { img: ['https', 'data'] },
    transformTags: {
      'a': (tagName, attribs) => {
        // Normalise before the scheme filter runs, as sanitizeEmail() already does on the
        // receive path. Without it an http:// href was discarded rather than upgraded to
        // https, and http:// is exactly what the composer emits for a typed bare domain,
        // because Tiptap autolinks with defaultProtocol 'http'. So "example.com" became
        // http://example.com and arrived as an anchor with no destination.
        const out = { ...attribs, rel: 'noopener noreferrer', target: '_blank' };
        if ('href' in out) {
          const normalized = normalizeHref(out.href);
          if (normalized === null) delete out.href;
          else out.href = normalized;
        }
        return { tagName, attribs: out };
      },
    },
    disallowedTagsMode: 'discard',
  });
}

// Sanitize user-authored signature HTML — allows common formatting and images
// but strips all event handlers and scripts. Stricter than sanitizeEmail().
export function sanitizeSignature(html) {
  if (!html) return html;
  return sanitizeHtml(html, {
    allowedTags: [
      'a', 'b', 'strong', 'i', 'em', 'u', 's', 'del',
      'p', 'br', 'div', 'span', 'img',
      'ul', 'ol', 'li',
      'h1', 'h2', 'h3', 'hr',
      'table', 'thead', 'tbody', 'tr', 'th', 'td',
      'font', 'center',
    ],
    allowedAttributes: {
      '*': ['style', 'class'],
      'a': ['href', 'target', 'rel'],
      'img': ['src', 'alt', 'width', 'height'],
      'font': ['color', 'size', 'face'],
      'td': ['colspan', 'rowspan', 'align', 'valign', 'width', 'height', 'bgcolor'],
      'th': ['colspan', 'rowspan', 'align', 'valign'],
      'table': ['width', 'cellpadding', 'cellspacing', 'border', 'align', 'bgcolor'],
    },
    // Every scheme normalizeHref can emit must be listed. Anything it produces that is not
    // allowed gets its href stripped while the <a> survives, which renders as a link but
    // does nothing when clicked.
    allowedSchemes: ['https', 'mailto', 'tel', 'sms', 'cid'],
    allowedSchemesByTag: { img: ['https', 'data'] },
    transformTags: {
      'a': (tagName, attribs) => {
        // Normalise before the scheme filter runs, as sanitizeEmail() already does on the
        // receive path. Without it an http:// href was discarded rather than upgraded to
        // https, and http:// is exactly what the composer emits for a typed bare domain,
        // because Tiptap autolinks with defaultProtocol 'http'. So "example.com" became
        // http://example.com and arrived as an anchor with no destination.
        const out = { ...attribs, rel: 'noopener noreferrer', target: '_blank' };
        if ('href' in out) {
          const normalized = normalizeHref(out.href);
          if (normalized === null) delete out.href;
          else out.href = normalized;
        }
        return { tagName, attribs: out };
      },
    },
    disallowedTagsMode: 'discard',
  });
}

// Remote here means http(s) or protocol-relative ("//host/...", which the email frame resolves to
// https); browsers ignore leading whitespace in a URL, so the patterns below do too.

const REMOTE_URL = /^\s*(?:https?:)?\/\//i;
const isCssSpace = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';

// Every remote URL in CSS text, rewritten by `rewrite(kind, url, token)`, which returns the text
// that replaces the whole token: kind 'url' for url(...), 'string' for a quoted URL inside
// image-set(), 'import' for an @import rule (through its ';'). `token` is { text, before, value,
// after }: the token as written, split around the URL's own characters (`value`, untrimmed), so a
// rewrite can replace the URL alone. Anything else is copied as it is.
//
// One pass from left to right that never reads text twice: every search for a closing character
// remembers where it last looked. Patterns that scan ahead from each candidate (url\(...\)) cost
// time in proportion to candidates times length, and a <style> of 40,000 unclosed url( held the
// event loop for half a minute. Here time grows only with the length of the CSS.
// Case-insensitive needles are searched with regexes over the CSS itself, not over a lowercased
// copy: lowercasing can change the length of a string (İ becomes two characters), and positions in
// the copy would then point at the wrong text.
const CSS_NEEDLES = { 'url(': /url\(/gi, 'image-set(': /image-set\(/gi, '@import': /@import/gi };
const startsWithCi = (text, at, needle) => text.slice(at, at + needle.length).toLowerCase() === needle;

function rewriteCssUrls(css, rewrite) {
  const n = css.length;
  const found = new Map();
  // The next index of `needle` at or after `from`. A result is reused while it still answers the
  // question, so a search never covers the same text twice as long as `from` only grows.
  const next = (needle, from) => {
    const hit = found.get(needle);
    if (hit && hit.from <= from && (hit.at === -1 || hit.at >= from)) return hit.at;
    let at;
    const re = CSS_NEEDLES[needle];
    if (re) {
      re.lastIndex = from;
      const m = re.exec(css);
      at = m ? m.index : -1;
    } else {
      at = css.indexOf(needle, from);
    }
    found.set(needle, { from, at });
    return at;
  };
  // A url( token starting at `start` (the 'u'): its pieces and the index after its ')', or null.
  const urlToken = (start) => {
    let j = start + 4;
    while (j < n && isCssSpace(css[j])) j += 1;
    let valueStart;
    let valueEnd;
    let k;
    if (css[j] === '"' || css[j] === "'") {
      const close = next(css[j], j + 1);
      if (close === -1) return null;
      valueStart = j + 1;
      valueEnd = close;
      k = close + 1;
    } else {
      k = j;
      while (k < n && css[k] !== ')' && css[k] !== '(' && css[k] !== '"' && css[k] !== "'" && !isCssSpace(css[k])) k += 1;
      valueStart = j;
      valueEnd = k;
    }
    while (k < n && isCssSpace(css[k])) k += 1;
    if (css[k] !== ')') return null;
    const end = k + 1;
    return {
      value: css.slice(valueStart, valueEnd), end,
      token: { text: css.slice(start, end), before: css.slice(start, valueStart), value: css.slice(valueStart, valueEnd), after: css.slice(valueEnd, end) },
    };
  };

  let out = '';
  let i = 0;
  while (i < n) {
    const candidates = [['url', next('url(', i)], ['set', next('image-set(', i)], ['import', next('@import', i)]]
      .filter(([, at]) => at !== -1);
    if (!candidates.length) break;
    const [kind, at] = candidates.reduce((a, b) => (b[1] < a[1] ? b : a));
    out += css.slice(i, at);
    if (kind === 'url') {
      const token = urlToken(at);
      if (token && REMOTE_URL.test(token.value)) { out += rewrite('url', token.value.trim(), token.token); i = token.end; continue; }
      out += css.slice(at, at + 4);
      i = at + 4;
    } else if (kind === 'import') {
      const semi = next(';', at);
      const end = semi === -1 ? n : semi + 1;
      let j = at + 7;
      while (j < end && isCssSpace(css[j])) j += 1;
      let target = '';
      if (startsWithCi(css, j, 'url(')) target = urlToken(j)?.value ?? '';
      else if (css[j] === '"' || css[j] === "'") { const close = next(css[j], j + 1); target = close === -1 ? '' : css.slice(j + 1, close); }
      if (REMOTE_URL.test(target)) {
        const text = css.slice(at, end);
        out += rewrite('import', target.trim(), { text, before: text, value: '', after: '' });
        i = end;
        continue;
      }
      out += css.slice(at, at + 7);
      i = at + 7;
    } else {
      // image-set( ... ): to its matching ')', its quoted URLs and url() tokens rewritten.
      const open = at + 'image-set('.length;
      out += css.slice(at, open);
      let depth = 1;
      let k = open;
      while (k < n && depth > 0) {
        const c = css[k];
        if (c === '"' || c === "'") {
          const close = next(c, k + 1);
          const stop = close === -1 ? n : close + 1;
          const value = css.slice(k + 1, close === -1 ? n : close);
          out += REMOTE_URL.test(value)
            ? rewrite('string', value.trim(), { text: css.slice(k, stop), before: c, value, after: close === -1 ? '' : c })
            : css.slice(k, stop);
          k = stop;
        } else if (startsWithCi(css, k, 'url(')) {
          const token = urlToken(k);
          if (token && REMOTE_URL.test(token.value)) { out += rewrite('url', token.value.trim(), token.token); k = token.end; }
          else { out += css.slice(k, k + 4); k += 4; depth += 1; }
        } else {
          if (c === '(') depth += 1;
          else if (c === ')') depth -= 1;
          out += c;
          k += 1;
        }
      }
      i = k;
    }
  }
  return out + css.slice(i);
}

// Remote loads in CSS text made inert: url(...) and quoted URLs in image-set() become data:,
// (which draws nothing) and remote @imports are dropped. url(data:,) carries no quotes, so it is
// safe inside any attribute or style block.
const blockCssUrls = (css) =>
  rewriteCssUrls(css, (kind) => (kind === 'import' ? '' : kind === 'url' ? 'url(data:,)' : '"data:,"'));

// An attribute value as written in the HTML, and back. Sanitized HTML writes values in double
// quotes with " as &quot;, & as &amp; and < > as &lt; &gt;; a CSS URL quoted with " is only
// visible once decoded, and what was decoded is encoded again the same way.
const decodeAttr = (v) => v
  .replace(/&quot;|&#0*34;|&#x0*22;/gi, '"').replace(/&#0*39;|&#x0*27;|&apos;/gi, "'")
  .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&');
const encodeAttr = (v) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Whether the HTML loads anything remote that blockRemoteImages would stop: exactly when blocking
// would change it, so the two can never disagree.
export function hasRemoteImages(html) {
  if (!html) return false;
  return blockRemoteImages(html) !== html;
}

// Rewrite remote http/https image references so the browser makes no network requests.
// data: and cid: sources are always left intact.
// Never call this on HTML that will be written back to the database — apply only at
// response time so the canonical cached body remains unmodified.
//
// This is the first line only: the email frame also forbids remote images, fonts and media in its
// Content-Security-Policy whenever a body is served blocked (remoteImagesBlocked), which stops what
// no pattern here can foresee (CSS escapes, for one).
export function blockRemoteImages(html) {
  if (!html) return html;

  // Block <img src="https://..."> — replace with a dimension-preserving SVG placeholder
  // so no network request fires.  A plain data:, produces a 0×0 image; emails that use
  // height:auto CSS (like marketing templates) would then collapse all images to 0px tall,
  // making the entire email appear blank.  Reading the explicit width/height attributes
  // lets us generate a grey rectangle that matches the layout slot the author intended.
  // An attribute value runs to its own quote: a URL may hold the other one (a'b.png in "...").
  let out = html.replace(
    /(<img\b[^>]*?)\ssrc=(?:"\s*(?:https?:)?\/\/[^"]*"|'\s*(?:https?:)?\/\/[^']*')/gi,
    (match, pre) => {
      const wMatch = pre.match(/\bwidth=["']?(\d+)["']?/i);
      const hMatch = pre.match(/\bheight=["']?(\d+)["']?/i);
      const w = wMatch ? parseInt(wMatch[1], 10) : 600;
      const h = hMatch ? parseInt(hMatch[1], 10) : 200;
      const svg = encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#e8e8e8"/></svg>`
      );
      return `${pre} src="data:image/svg+xml,${svg}"`;
    }
  );

  // Remove img srcset entirely when it contains any remote URLs.
  out = out.replace(
    /(<img\b[^>]*?)\ssrcset=(?:"([^"]*)"|'([^']*)')/gi,
    (match, pre, doubleQuoted, singleQuoted) =>
      /(?:^|[\s,])(?:https?:)?\/\//i.test(doubleQuoted ?? singleQuoted) ? pre : match
  );

  // Blank background="https://..." attribute (table-based marketing email layouts).
  out = out.replace(
    /(\s)background=(?:"\s*(?:https?:)?\/\/[^"]*"|'\s*(?:https?:)?\/\/[^']*')/gi,
    '$1background=""'
  );

  // Block CSS url(https://...) in inline style= attributes, read as the browser will read them.
  // Left byte for byte as it was when there is nothing to block.
  out = out.replace(
    /(\sstyle=)(?:"([^"]*)"|'([^']*)')/gi,
    (match, attr, doubleQuoted, singleQuoted) => {
      const css = decodeAttr(doubleQuoted ?? singleQuoted);
      const blocked = blockCssUrls(css);
      return blocked === css ? match : `${attr}"${encodeAttr(blocked)}"`;
    }
  );

  // Block remote CSS loads inside <style> blocks: remote @imports dropped, url(...) and
  // image-set() URLs made inert.
  out = rewriteStyleBlocks(out, blockCssUrls);

  return out;
}

// The URL a remote image reference loads, from its text: protocol-relative ("//host/...") is
// https, as the email frame resolves it.
const remoteUrlOf = (text) => {
  const url = text.trim();
  return url.startsWith('//') ? `https:${url}` : url;
};

// Every remote image reference in sanitized HTML, passed to `replace(raw, url)`: `raw` is the
// reference exactly as written in the HTML (in an attribute, with its entities), `url` what it
// loads. The result takes the place of `raw` and nothing around it changes, so a replacement that
// carries `raw` can always be turned back into the original HTML. Covers what blockRemoteImages
// blocks, but for remote @imports, which are left alone: they are stylesheets, not images, and the
// email frame's CSP never loads one.
function rewriteRemoteImageRefs(html, replace) {
  if (!html) return html;
  const remote = (raw) => /^\s*(?:https?:)?\/\//i.test(raw);
  // An attribute value runs to its own quote: a URL may hold the other one.
  const attrUrl = (_, pre, doubleQuoted, singleQuoted) => {
    const q = doubleQuoted === undefined ? "'" : '"';
    const raw = doubleQuoted ?? singleQuoted;
    return `${pre}${q}${replace(raw, remoteUrlOf(decodeAttr(raw)))}${q}`;
  };
  let out = html.replace(/(<img\b[^>]*?\ssrc=)(?:"(\s*(?:https?:)?\/\/[^"]*)"|'(\s*(?:https?:)?\/\/[^']*)')/gi, attrUrl);
  out = out.replace(
    /(<img\b[^>]*?\ssrcset=)(?:"([^"]*)"|'([^']*)')/gi,
    (_, pre, doubleQuoted, singleQuoted) => {
      const q = doubleQuoted === undefined ? "'" : '"';
      const value = doubleQuoted ?? singleQuoted;
      return `${pre}${q}${mapSrcsetUrls(value, raw => (remote(raw) ? replace(raw, remoteUrlOf(decodeAttr(raw))) : raw))}${q}`;
    },
  );
  out = out.replace(/(\sbackground=)(?:"(\s*(?:https?:)?\/\/[^"]*)"|'(\s*(?:https?:)?\/\/[^']*)')/gi, attrUrl);
  // An inline style is read decoded, as the browser reads it; each URL is replaced as it is
  // written in the HTML (encodeAttr of its decoded text, which is how sanitized HTML writes it).
  out = out.replace(
    /(\sstyle=)(?:"([^"]*)"|'([^']*)')/gi,
    (match, attr, doubleQuoted, singleQuoted) => {
      const css = decodeAttr(doubleQuoted ?? singleQuoted);
      const rewritten = rewriteCssUrls(css, (kind, url, token) => (kind === 'import'
        ? token.text
        : `${token.before}${replace(encodeAttr(token.value), remoteUrlOf(url))}${token.after}`));
      return rewritten === css ? match : `${attr}"${encodeAttr(rewritten)}"`;
    },
  );
  out = rewriteStyleBlocks(out, content => rewriteCssUrls(content, (kind, url, token) => (kind === 'import'
    ? token.text
    : `${token.before}${replace(token.value, remoteUrlOf(url))}${token.after}`)));
  return out;
}

// Open-tracking images. The image proxy hides the reader's address, but fetching a tracking pixel
// still tells the sender the email was opened, so MailFlow does not fetch these at all: an <img>
// the email itself sizes at 2x2 px or less (width and height, as attributes or inline style), and
// the open-tracking addresses of the common sending platforms. Images hidden with display:none are
// not counted: senders hide a dark-mode logo that way.
const TINY = 2;
const IMAGE_FILE = /\.(?:png|jpe?g|gif|webp|avif|bmp|svg)$/i;
const OPEN_SEGMENT = /^open(?:ed)?(?:\.(?:gif|png|jpe?g|php|aspx?))?$/i;
const TRACKER_FILE = /^(?:pixel|beacon|track(?:ing)?|open)\.(?:gif|png)$/i;
const TOKEN = /^[\w.=~-]{16,}$/;
const SLUG = /^[a-z]+(?:[-_][a-z]+)+$/i; // hero-banner, spring_sale: a name, not a tracking token

// Whether `url` is a known open-tracking address. Only the path is read.
export function isTrackingUrl(url) {
  let path;
  let host;
  try {
    ({ pathname: path, hostname: host } = new URL(url));
  } catch {
    return false;
  }
  const segs = path.split('/').filter(Boolean);
  if (!segs.length) return false;
  const last = segs[segs.length - 1];
  if (TRACKER_FILE.test(last)) return true;
  // .../open, .../open.php, .../open/<token> (SendGrid /wf/open, Mailchimp /track/open.php,
  // Salesforce /open.aspx, /api/notifications/v1/open/<token>), but not /open/images/logo.png, nor
  // a readable name after it (/products/open/hero-banner).
  for (let i = Math.max(0, segs.length - 2); i < segs.length; i += 1) {
    if (OPEN_SEGMENT.test(segs[i]) && (i === segs.length - 1 || (!IMAGE_FILE.test(last) && !SLUG.test(last)))) return true;
  }
  // Mailgun /o/<token>, Customer.io /e/o/<token>, Amazon SES /I0/<token> and /CI0/<token>. Firebase
  // Storage serves every file under /o/<name>, newsletter images included.
  if (/(?:^|\.)firebasestorage\.(?:googleapis\.com|app)$/i.test(host)) return false;
  if (segs.length >= 2 && ['o', 'I0', 'CI0'].includes(segs[segs.length - 2]) && TOKEN.test(last) && !IMAGE_FILE.test(last)) return true;
  return false;
}

const dimension = (tag, name) => {
  // One whitespace run before the value, another only after a quote: a long run of spaces cannot
  // be split between two quantifiers (linear on hostile input; emailSanitizer.trackers.test.js times it).
  const attr = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:["']\\s*)?(\\d+(?:\\.\\d+)?)(?:px)?[\\s"'/>]`, 'i'));
  if (attr) return Number(attr[1]);
  const style = tag.match(/\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
  if (!style) return null;
  const css = decodeAttr(style[1] ?? style[2]);
  const decl = css.match(new RegExp(`(?:^|[;\\s])${name}\\s*:\\s*(\\d+(?:\\.\\d+)?)px`, 'i'));
  return decl ? Number(decl[1]) : null;
};

// The width each <img> src (as written) is shown at, where the email gives one in pixels: the
// widest, when one image is used more than once. What the image proxy fits the image to.
function shownWidths(html) {
  const out = new Map();
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const src = tag.match(/\ssrc=(?:"([^"]*)"|'([^']*)')/i);
    const width = dimension(tag, 'width');
    if (!src || !(width > 0)) continue;
    const raw = src[1] ?? src[2];
    out.set(raw, Math.max(out.get(raw) ?? 0, width));
  }
  return out;
}

// The src of every <img> in `html` sized at TINY px or less both ways, as written.
function tinyImageSrcs(html) {
  const out = new Set();
  for (const [tag] of html.matchAll(/<img\b[^>]*>/gi)) {
    const w = dimension(tag, 'width');
    const h = dimension(tag, 'height');
    if (w === null || h === null || w > TINY || h > TINY) continue;
    const src = tag.match(/\ssrc=(?:"([^"]*)"|'([^']*)')/i);
    if (src) out.add(src[1] ?? src[2]);
  }
  return out;
}

const trackerTest = (html) => {
  const tiny = tinyImageSrcs(html);
  return (raw, url) => tiny.has(raw) || isTrackingUrl(url);
};

// What a blocked tracker becomes: an image that draws nothing, so the layout stays as sent.
export const TRACKER_REPLACEMENT = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

// Remote images loaded through MailFlow's image proxy: every remote image reference in sanitized
// HTML becomes `toProxy(raw)` (routes/mail.js imageProxyPath), which carries the reference as it
// was written, so the original can be restored exactly (the frontend's utils/imageProxy.js does,
// for replies and forwards). Open-tracking images are not loaded: they become
// TRACKER_REPLACEMENT, and `stats.trackers` counts the distinct ones.
export function proxyRemoteImages(html, toProxy, stats = {}) {
  if (!html) return html;
  const isTracker = trackerTest(html);
  const trackers = new Set();
  const widths = shownWidths(html);
  const out = rewriteRemoteImageRefs(html, (raw, url) => {
    if (!isTracker(raw, url)) return toProxy(raw, widths.get(raw) ?? null);
    trackers.add(url);
    return TRACKER_REPLACEMENT;
  });
  stats.trackers = trackers.size;
  return out;
}

// The remote image references in sanitized HTML, as written, with what each loads: the only URLs
// the image proxy will fetch for this message. Open-tracking images are left out.
// Each candidate URL in a srcset, as the browser splits it: a URL runs to the next whitespace, so a
// comma inside it is part of it (Cloudinary's /w_100,h_50/, a data: URI), and one right after it
// ends the candidate; otherwise the candidate's descriptors run to the next comma. Splitting on
// every comma cut those URLs in two, and the image came back missing.
function mapSrcsetUrls(value, map) {
  let out = '';
  let pos = 0;
  const n = value.length;
  const space = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
  while (pos < n) {
    let start = pos;
    while (pos < n && (space(value[pos]) || value[pos] === ',')) pos += 1;
    out += value.slice(start, pos);
    if (pos >= n) break;
    start = pos;
    while (pos < n && !space(value[pos])) pos += 1;
    let url = value.slice(start, pos);
    let end = url.length;
    while (end > 0 && url[end - 1] === ',') end -= 1;
    const commas = url.slice(end);
    url = url.slice(0, end);
    out += (url ? map(url) : '') + commas;
    if (commas) continue;
    start = pos;
    while (pos < n && value[pos] !== ',') pos += 1;
    out += value.slice(start, pos);
  }
  return out;
}

export function remoteImageRefs(html) {
  const refs = new Map();
  if (!html) return refs;
  const isTracker = trackerTest(html);
  rewriteRemoteImageRefs(html, (raw, url) => {
    if (!refs.has(raw) && !isTracker(raw, url)) refs.set(raw, url);
    return raw;
  });
  return refs;
}
