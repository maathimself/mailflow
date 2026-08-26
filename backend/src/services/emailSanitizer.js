import sanitizeHtml from 'sanitize-html';
import parseSrcset from 'parse-srcset';

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
  const lower = str.toLowerCase();
  const close = closeLiteral.toLowerCase();
  let out = '';
  let pos = 0;
  let m;
  openNameRe.lastIndex = 0;
  while ((m = openNameRe.exec(str)) !== null) {
    const gt = str.indexOf('>', m.index);
    if (gt === -1) break; // unterminated opening tag — no match, like [^>]*> would fail
    const contentStart = gt + 1;
    const closeIdx = lower.indexOf(close, contentStart);
    if (closeIdx === -1) break;
    const spanEnd = closeIdx + closeLiteral.length;
    out += str.slice(pos, m.index) + transform(str.slice(m.index, contentStart), str.slice(contentStart, closeIdx), str.slice(closeIdx, spanEnd));
    pos = spanEnd;
    openNameRe.lastIndex = spanEnd;
  }
  return out + str.slice(pos);
}

// Strip MSO-positive conditional comments (<!--[if mso]>…<![endif]-->) linearly,
// preserving <!--[if !mso]> blocks (browser-targeted CSS). Mirrors the old regex
// /<!--\[if(?!\s*!)[^\]]*\]>[\s\S]*?<!\[endif\]-->/gi without its backtracking.
function stripMsoConditionals(hc) {
  const END = '<![endif]-->';
  const lower = hc.toLowerCase();
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
    const endIdx = lower.indexOf(END.toLowerCase(), rb + 2);
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


const EMAIL_RESOURCE_BASE = new URL('https://mailflow.invalid/');

function serializedResourceUrl(parsed, source) {
  const href = parsed.href;
  const trimmed = source.trim();
  // Preserve the long-standing no-trailing-slash representation for a bare
  // authority while still using WHATWG serialization for every nontrivial URL.
  return parsed.pathname === '/'
    && !parsed.search
    && !parsed.hash
    && /^(?:https?:)?[\\/]{2}[^\\/?#]+$/i.test(trimmed)
    ? href.slice(0, -1)
    : href;
}

// Parse with a fixed, deliberately non-routable base so the decision matches a
// browser without ever granting app-origin meaning to a relative email URL.
// WHATWG parsing is important here: special-scheme URLs accept backslashes as
// separators and ignore embedded tab/newline controls in schemes.
function classifyResourceUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  let parsed;
  try {
    parsed = new URL(value, EMAIL_RESOURCE_BASE);
  } catch {
    return null;
  }

  const protocol = parsed.protocol.toLowerCase();
  if (protocol === 'data:' || protocol === 'cid:') {
    return { kind: 'local', url: parsed.href };
  }
  if (protocol !== 'http:' && protocol !== 'https:') return null;

  // `https:tracker.invalid/x` is path-relative when the document scheme is
  // https, whereas `http:tracker.invalid/x` is an absolute special-scheme URL.
  // Comparing fixed-base and standalone parses distinguishes those cases while
  // still accepting protocol-relative and backslash network-path references.
  if (parsed.origin === EMAIL_RESOURCE_BASE.origin) {
    try {
      if (new URL(value).href !== parsed.href) return null;
    } catch {
      return null;
    }
  }

  if (protocol === 'http:') parsed.protocol = 'https:';
  return { kind: 'network', url: serializedResourceUrl(parsed, value) };
}

function isNetworkResource(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  return classifyResourceUrl(value)?.kind !== 'local';
}

function upgradeUrl(url) {
  return classifyResourceUrl(url)?.url ?? null;
}

function transformSrcsetUrls(srcset, transform) {
  let candidates;
  try {
    candidates = parseSrcset(srcset);
  } catch {
    return null;
  }
  if (!candidates.length) return null;
  const transformed = [];
  for (const candidate of candidates) {
    const url = transform(candidate.url);
    if (typeof url !== 'string' || !url) return null;
    const descriptor = candidate.w !== undefined
      ? `${candidate.w}w`
      : candidate.d !== undefined
        ? `${candidate.d}x`
        : candidate.h !== undefined
          ? `${candidate.h}h`
          : '';
    transformed.push(descriptor ? `${url} ${descriptor}` : url);
  }
  return transformed.join(', ');
}

function srcsetHasNetworkUrl(srcset) {
  let found = false;
  const parsed = transformSrcsetUrls(srcset, candidate => {
    if (isNetworkResource(candidate)) found = true;
    return candidate;
  });
  return parsed === null || found;
}

function sanitizeSrcset(srcset) {
  let unsafe = false;
  const sanitized = transformSrcsetUrls(srcset, candidate => {
    const classified = classifyResourceUrl(candidate);
    if (!classified) {
      unsafe = true;
      return candidate;
    }
    return classified.url;
  });
  return unsafe ? null : sanitized;
}

// Normalise an anchor href value to an absolute https/mailto/tel URL, or return
// null if the href cannot be safely resolved (relative paths, fragments, etc.).
// Returns null for hrefs that would resolve against the mailflow origin in a
// same-origin srcdoc iframe — callers should omit the href attribute entirely.
function normalizeHref(href) {
  if (!href) return null;
  const h = href.trim();
  if (!h) return null;
  const resource = classifyResourceUrl(h);
  if (resource?.kind === 'network') return resource.url;
  try {
    const parsed = new URL(h);
    if (['mailto:', 'cid:', 'tel:', 'sms:'].includes(parsed.protocol.toLowerCase())) {
      return parsed.href;
    }
  } catch { /* handled by the relative/bare-domain policy below */ }
  // Fragment, root-relative, path-relative, query-only — unsafe to resolve in iframe
  if (/^[#/?.\\]/i.test(h)) return null;
  // Bare domain (e.g. "benchmade.com", "example.com:8443/path") — no scheme,
  // starts like a hostname, and has a dot. Parsing the https-prefixed candidate
  // rejects invalid hosts and non-numeric/out-of-range ports before we accept it.
  if (/^[a-z0-9]/i.test(h) && h.includes('.')) {
    const normalized = classifyResourceUrl(`https://${h}`)?.url;
    if (normalized) return normalized;
  }
  // Explicitly block dangerous or unknown schemes that reached this point.
  if (h.includes(':')) return null;
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

// Canonicalize allowed CSS url() resources and neutralize URLs that would need
// an email/app base. Handles quoted, unquoted, escaped, and commented forms.
function serializeCssString(value) {
  let out = '"';
  for (const char of value) {
    const codePoint = char.codePointAt(0);
    if (char === '"' || char === '\\') out += `\\${char}`;
    else if (codePoint === 0 || (codePoint >= 0xd800 && codePoint <= 0xdfff)) out += '\ufffd';
    else if (codePoint <= 0x1f || codePoint === 0x7f) out += `\\${codePoint.toString(16)} `;
    else out += char;
  }
  return `${out}"`;
}

function upgradeStyleUrls(style) {
  if (!style) return style;
  let out = '';
  let pos = 0;
  let cursor = 0;
  while (cursor < style.length) {
    if (style[cursor] === '/' && style[cursor + 1] === '*') {
      const close = style.indexOf('*/', cursor + 2);
      cursor = close === -1 ? style.length : close + 2;
    } else if (style[cursor] === '"' || style[cursor] === "'") {
      const string = readCssString(style, cursor);
      cursor = string ? string.end : style.length;
    } else if (isCssNameChar(style[cursor]) || style[cursor] === '\\') {
      const name = readCssIdentifier(style, cursor);
      if (name.value.toLowerCase() === 'url') {
        const url = readCssUrlFunction(style, name.end);
        if (url && url.value.trim()) {
          const classified = classifyResourceUrl(url.value);
          out += `${style.slice(pos, cursor)}url(${serializeCssString(classified?.url ?? '')})`;
          pos = url.end;
          cursor = url.end;
          continue;
        }
      }
      cursor = name.end;
    } else {
      cursor++;
    }
  }
  return out + style.slice(pos);
}

function isCssWhitespace(char) {
  return char === ' ' || char === '\n' || char === '\r' || char === '\t' || char === '\f';
}

function isCssNameChar(char) {
  return Boolean(char) && /[a-z0-9_-]/i.test(char);
}

// Decode one CSS escape for security classification. This deliberately covers the
// CSS escape forms that can spell an at-keyword, function name, or URL scheme.
function readCssEscape(css, start) {
  let cursor = start + 1;
  if (cursor >= css.length) return { value: '', end: cursor };

  // CSS line continuations contribute no character. CRLF is one continuation.
  if (css[cursor] === '\n' || css[cursor] === '\f') return { value: '', end: cursor + 1 };
  if (css[cursor] === '\r') {
    return { value: '', end: css[cursor + 1] === '\n' ? cursor + 2 : cursor + 1 };
  }

  if (/[0-9a-f]/i.test(css[cursor])) {
    const hexStart = cursor;
    while (cursor < css.length && cursor - hexStart < 6 && /[0-9a-f]/i.test(css[cursor])) cursor++;
    const codePoint = Number.parseInt(css.slice(hexStart, cursor), 16);
    if (css[cursor] === '\r' && css[cursor + 1] === '\n') cursor += 2;
    else if (isCssWhitespace(css[cursor])) cursor++;
    return { value: codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : '\ufffd', end: cursor };
  }

  return { value: css[cursor], end: cursor + 1 };
}

function readCssIdentifier(css, start) {
  let value = '';
  let cursor = start;
  while (cursor < css.length) {
    if (css[cursor] === '\\') {
      const escaped = readCssEscape(css, cursor);
      value += escaped.value;
      cursor = escaped.end;
    } else if (isCssNameChar(css[cursor])) {
      value += css[cursor++];
    } else {
      break;
    }
  }
  return { value, end: cursor };
}

function skipCssWhitespaceAndComments(css, start, end = css.length) {
  let cursor = start;
  while (cursor < end) {
    if (isCssWhitespace(css[cursor])) {
      cursor++;
    } else if (css[cursor] === '/' && css[cursor + 1] === '*') {
      const close = css.indexOf('*/', cursor + 2);
      cursor = close === -1 ? end : close + 2;
    } else {
      break;
    }
  }
  return cursor;
}

function readCssString(css, start, end = css.length) {
  const quote = css[start];
  let value = '';
  let cursor = start + 1;
  while (cursor < end) {
    if (css[cursor] === quote) return { value, end: cursor + 1 };
    if (css[cursor] === '\\') {
      const escaped = readCssEscape(css, cursor);
      value += escaped.value;
      cursor = escaped.end;
    } else {
      value += css[cursor++];
    }
  }
  return null;
}

function readCssUrlFunction(css, start, end = css.length) {
  let cursor = skipCssWhitespaceAndComments(css, start, end);
  if (css[cursor] !== '(') return null;
  cursor = skipCssWhitespaceAndComments(css, cursor + 1, end);

  let value = '';
  if (css[cursor] === '"' || css[cursor] === "'") {
    const string = readCssString(css, cursor, end);
    if (!string) return null;
    value = string.value;
    cursor = skipCssWhitespaceAndComments(css, string.end, end);
  } else {
    while (cursor < end && css[cursor] !== ')') {
      if (css[cursor] === '\\') {
        const escaped = readCssEscape(css, cursor);
        value += escaped.value;
        cursor = escaped.end;
      } else {
        value += css[cursor++];
      }
    }
    value = value.trim();
  }

  return css[cursor] === ')' ? { value, end: cursor + 1 } : null;
}

function scanCssFunctionForVar(css, open) {
  let cursor = open + 1;
  let depth = 1;
  let hasVar = false;
  while (cursor < css.length) {
    if (css[cursor] === '/' && css[cursor + 1] === '*') {
      const close = css.indexOf('*/', cursor + 2);
      cursor = close === -1 ? css.length : close + 2;
    } else if (css[cursor] === '"' || css[cursor] === "'") {
      const string = readCssString(css, cursor);
      cursor = string ? string.end : css.length;
    } else if (isCssNameChar(css[cursor]) || css[cursor] === '\\') {
      const name = readCssIdentifier(css, cursor);
      if (name.value.toLowerCase() === 'var'
        && css[skipCssWhitespaceAndComments(css, name.end)] === '(') hasVar = true;
      cursor = name.end;
    } else if (css[cursor] === '(') {
      depth++;
      cursor++;
    } else if (css[cursor] === ')') {
      depth--;
      cursor++;
      if (depth === 0) return { end: cursor, hasVar };
    } else {
      cursor++;
    }
  }
  return null;
}

function isExternalCssUrl(value) {
  return isNetworkResource(value);
}

function findCssAtRuleEnd(css, start) {
  let cursor = start;
  let quote = null;
  let parenDepth = 0;
  while (cursor < css.length) {
    if (quote) {
      if (css[cursor] === '\\') cursor = readCssEscape(css, cursor).end;
      else if (css[cursor++] === quote) quote = null;
    } else if (css[cursor] === '/' && css[cursor + 1] === '*') {
      const close = css.indexOf('*/', cursor + 2);
      cursor = close === -1 ? css.length : close + 2;
    } else if (css[cursor] === '"' || css[cursor] === "'") {
      quote = css[cursor++];
    } else if (css[cursor] === '(') {
      parenDepth++;
      cursor++;
    } else if (css[cursor] === ')' && parenDepth > 0) {
      parenDepth--;
      cursor++;
    } else if (css[cursor++] === ';' && parenDepth === 0) {
      return cursor;
    }
  }
  return cursor;
}

function importHasExternalUrl(css, start, end) {
  const sourceStart = skipCssWhitespaceAndComments(css, start, end);
  if (css[sourceStart] === '"' || css[sourceStart] === "'") {
    const string = readCssString(css, sourceStart, end);
    return Boolean(string) && isExternalCssUrl(string.value);
  }

  const name = readCssIdentifier(css, sourceStart);
  if (name.value.toLowerCase() === 'url') {
    const url = readCssUrlFunction(css, name.end, end);
    return Boolean(url) && isExternalCssUrl(url.value);
  }

  let cursor = sourceStart;
  let value = '';
  while (cursor < end && !isCssWhitespace(css[cursor]) && css[cursor] !== ';') {
    if (css[cursor] === '\\') {
      const escaped = readCssEscape(css, cursor);
      value += escaped.value;
      cursor = escaped.end;
    } else {
      value += css[cursor++];
    }
  }
  return isExternalCssUrl(value);
}

// Strip network-capable or base-relative style resources at sanitize time. The
// scanner is bounded and linear and ignores at-keyword-like text in strings/comments.
function stripExternalStyleBlockResources(css, {
  stripExternalUrls = true,
  stripExternalImports = true,
} = {}) {
  let out = '';
  let pos = 0;
  let cursor = 0;
  let parenDepth = 0;
  const imageSetDepths = [];

  while (cursor < css.length) {
    if (css[cursor] === '/' && css[cursor + 1] === '*') {
      const close = css.indexOf('*/', cursor + 2);
      cursor = close === -1 ? css.length : close + 2;
      continue;
    }
    if (css[cursor] === '"' || css[cursor] === "'") {
      const string = readCssString(css, cursor);
      if (string && imageSetDepths.at(-1) === parenDepth && isExternalCssUrl(string.value)) {
        out += css.slice(pos, cursor) + 'url()';
        pos = string.end;
      }
      cursor = string ? string.end : css.length;
      continue;
    }
    if (css[cursor] === '@') {
      const name = readCssIdentifier(css, cursor + 1);
      if (stripExternalImports && name.value.toLowerCase() === 'import') {
        const end = findCssAtRuleEnd(css, name.end);
        if (importHasExternalUrl(css, name.end, end)) {
          out += css.slice(pos, cursor);
          pos = end;
        }
        cursor = end;
        continue;
      }
    } else if (isCssNameChar(css[cursor]) || css[cursor] === '\\') {
      const name = readCssIdentifier(css, cursor);
      const lowerName = name.value.toLowerCase();
      if (lowerName === 'url') {
        const url = readCssUrlFunction(css, name.end);
        if (url) {
          if (isExternalCssUrl(url.value) && (stripExternalUrls || imageSetDepths.length > 0)) {
            out += css.slice(pos, cursor) + 'url()';
            pos = url.end;
          }
          cursor = url.end;
          continue;
        }
      }
      if (lowerName === 'image-set' || lowerName === '-webkit-image-set') {
        const open = skipCssWhitespaceAndComments(css, name.end);
        if (css[open] === '(') {
          if (imageSetDepths.length === 0) {
            const imageSet = scanCssFunctionForVar(css, open);
            if (imageSet?.hasVar) {
              out += css.slice(pos, cursor) + 'url()';
              pos = imageSet.end;
              cursor = imageSet.end;
              continue;
            }
          }
          parenDepth++;
          imageSetDepths.push(parenDepth);
          cursor = open + 1;
          continue;
        }
      }
      // A non-url identifier is a single token. Advancing by one character
      // would rescan every suffix, both corrupting foo-url() and becoming O(n²).
      cursor = name.end;
      continue;
    }
    if (css[cursor] === '(') {
      parenDepth++;
    } else if (css[cursor] === ')' && parenDepth > 0) {
      if (imageSetDepths.at(-1) === parenDepth) imageSetDepths.pop();
      parenDepth--;
    }
    cursor++;
  }

  return out + css.slice(pos);
}

function stripExternalStyleBlockUrls(html) {
  if (!html) return html;
  return scanPaired(html, /<style\b/gi, '</style>', (open, content, close) =>
    open + stripExternalStyleBlockResources(content) + close
  );
}

const INLINE_STYLE_ATTRIBUTE = /(\sstyle\s*=\s*)(?:"([^"]*)"|'([^']*)')/gi;

function decodeStyleQuoteEntities(value) {
  return value
    .replace(/&(?:quot|#0*34|#x0*22);/gi, '"')
    .replace(/&(?:apos|#0*39|#x0*27);/gi, "'");
}

function encodeStyleAttribute(value, quote) {
  return quote === '"' ? value.replace(/"/g, '&quot;') : value.replace(/'/g, '&#39;');
}

function transformInlineStyleAttributes(html, transform) {
  return html.replace(INLINE_STYLE_ATTRIBUTE, (match, prefix, doubleQuoted, singleQuoted) => {
    const quote = doubleQuoted === undefined ? "'" : '"';
    const value = decodeStyleQuoteEntities(doubleQuoted ?? singleQuoted);
    return `${prefix}${quote}${encodeStyleAttribute(transform(value), quote)}${quote}`;
  });
}

function stripExternalInlineImageResources(style) {
  return stripExternalStyleBlockResources(style, {
    // Ordinary url() references retain the established http→https upgrade.
    // url() inside image-set remains network-capable and is still neutralized.
    stripExternalUrls: false,
    stripExternalImports: false,
  });
}

function sanitizeInlineStyle(style) {
  return upgradeStyleUrls(stripExternalInlineImageResources(style));
}

function sanitizeResourceAttributes(attribs) {
  const out = { ...attribs };
  if ('background' in out) {
    const background = upgradeUrl(out.background);
    if (background === null) delete out.background;
    else out.background = background;
  }
  if (out.style) out.style = sanitizeInlineStyle(out.style);
  return out;
}

function hasExternalInlineStyleResources(html) {
  let found = false;
  html.replace(INLINE_STYLE_ATTRIBUTE, (match, _prefix, doubleQuoted, singleQuoted) => {
    const value = decodeStyleQuoteEntities(doubleQuoted ?? singleQuoted);
    if (stripExternalStyleBlockResources(value) !== value) found = true;
    return match;
  });
  return found;
}

function attributeHasNetworkUrl(html, pattern, srcset = false) {
  pattern.lastIndex = 0;
  let match;
  while ((match = pattern.exec(html))) {
    if (srcset ? srcsetHasNetworkUrl(match[2]) : isNetworkResource(match[2])) return true;
  }
  return false;
}

// Post-process sanitized HTML to upgrade http:// URLs inside <style> blocks.
// sanitize-html only transforms attributes, not element text content, so <style>
// block CSS must be handled separately after sanitization.
function upgradeStyleBlocks(html) {
  if (!html) return html;
  return scanPaired(html, /<style\b/gi, '</style>', (open, content, close) =>
    open + content.replace(/url\(\s*(['"]?)http:\/\//gi, (_, q) => `url(${q}https://`) + close
  );
}

// Sanitize HTML email body — permissive but safe.
export function sanitizeEmail(html) {
  const sanitized = sanitizeHtml(stripEmailHead(html), {
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
      'style',
    ],
    allowedAttributes: {
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
      // Ensure all links open safely.  Also normalise bare-domain hrefs like
      // "benchmade.com" → "https://benchmade.com" so they work as expected in
      // the sandboxed iframe, and strip relative/fragment hrefs that would
      // otherwise resolve to the mailflow origin.
      'a': (tagName, attribs) => {
        const out = { ...sanitizeResourceAttributes(attribs), rel: 'noopener noreferrer' };
        if ('href' in out) {
          const normalized = normalizeHref(out.href);
          if (normalized === null) delete out.href;
          else out.href = normalized;
        }
        return { tagName, attribs: out };
      },
      // Canonicalize genuine image resources and discard values that need an
      // application/document base. Plain HTTP is upgraded to avoid mixed content.
      'img': (tagName, attribs) => {
        const out = sanitizeResourceAttributes(attribs);
        if ('src' in out) {
          const src = upgradeUrl(out.src);
          if (src === null) delete out.src;
          else out.src = unwrapEbayImgUrl(src);
        }
        if ('srcset' in out) {
          const srcset = sanitizeSrcset(out.srcset);
          if (srcset === null) delete out.srcset;
          else out.srcset = srcset;
        }
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
        return { tagName, attribs: sanitizeResourceAttributes(attribs) };
      },
    },
    allowedSchemes: ['http', 'https', 'mailto', 'cid'],
    allowedSchemesByTag: {
      img: ['http', 'https', 'cid', 'data'],
      // sanitize-html validates srcset under the attribute name rather than the
      // owning tag. Without this entry it silently discards safe data: candidates.
      srcset: ['http', 'https', 'cid', 'data'],
    },
    disallowedTagsMode: 'discard',
  });

  // Upgrade safe resources and strip network-capable style-block URLs. Appearance
  // policy is applied to a disposable render in the frontend; the canonical
  // sanitized body retains safe sender light/dark rules and declarations.
  return upgradeStyleBlocks(stripExternalStyleBlockUrls(sanitized));
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
    allowedSchemes: ['https', 'mailto'],
    allowedSchemesByTag: { img: ['https', 'data'] },
    transformTags: {
      'a': (tagName, attribs) => ({
        tagName,
        attribs: { ...attribs, rel: 'noopener noreferrer', target: '_blank' },
      }),
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
    allowedSchemes: ['https', 'mailto'],
    allowedSchemesByTag: { img: ['https', 'data'] },
    transformTags: {
      'a': (tagName, attribs) => ({
        tagName,
        attribs: { ...attribs, rel: 'noopener noreferrer', target: '_blank' },
      }),
    },
    disallowedTagsMode: 'discard',
  });
}

// Returns true if HTML contains a network-capable or unsafe base-relative image
// reference. This intentionally handles legacy cached HTML as well as current output.
export function hasRemoteImages(html) {
  if (!html) return false;
  return (
    attributeHasNetworkUrl(html, /<img\b[^>]*\ssrc=(["'])([^"']*)\1/gi) ||
    attributeHasNetworkUrl(html, /<img\b[^>]*\ssrcset=(["'])([^"']*)\1/gi, true) ||
    attributeHasNetworkUrl(html, /\sbackground=(["'])([^"']*)\1/gi) ||
    hasExternalInlineStyleResources(html) ||
    stripExternalStyleBlockUrls(html) !== html
  );
}

// Rewrite remote http/https image references so the browser makes no network requests.
// data: and cid: sources are always left intact.
// Never call this on HTML that will be written back to the database — apply only at
// response time so the canonical cached body remains unmodified.
export function blockRemoteImages(html) {
  if (!html) return html;

  // Block <img src="https://..."> — replace with a dimension-preserving SVG placeholder
  // so no network request fires.  A plain data:, produces a 0×0 image; emails that use
  // height:auto CSS (like marketing templates) would then collapse all images to 0px tall,
  // making the entire email appear blank.  Reading the explicit width/height attributes
  // lets us generate a grey rectangle that matches the layout slot the author intended.
  let out = html.replace(
    /(<img\b[^>]*?)\ssrc=(["'])([^"']*)\2/gi,
    (match, pre, _quote, source) => {
      if (!isNetworkResource(source)) return match;
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
    /(<img\b[^>]*?)\ssrcset=(["'])([^"']*)\2/gi,
    (_, pre, q, val) =>
      srcsetHasNetworkUrl(val)
        ? pre
        : `${pre} srcset=${q}${val}${q}`
  );

  // Blank background="https://..." attribute (table-based marketing email layouts).
  out = out.replace(
    /(\s)background=(["'])([^"']*)\2/gi,
    (match, whitespace, quote, source) => (
      isNetworkResource(source) ? `${whitespace}background=${quote}${quote}` : match
    )
  );

  // Decode serialized quote entities before scanning inline CSS, then restore
  // attribute quoting. This also covers legacy cached image-set declarations.
  out = transformInlineStyleAttributes(out, styleVal => {
    const blockedUrls = styleVal.replace(
      /url\(\s*(['"]?)https?:\/\/[^'")]+\1\s*\)/gi,
      'url("data:,")'
    );
    return stripExternalStyleBlockResources(blockedUrls);
  });

  // Block remote CSS loads inside <style> blocks:
  // 1. Strip @import "https://..." (bare quoted form — not caught by url() pattern).
  // 2. Strip @import url(https://...) (url() form).
  // 3. Replace remaining url(https://...) CSS property values with data:,.
  out = scanPaired(out, /<style\b/gi, '</style>', (open, content, close) => {
    const blocked = content
      .replace(/@import\s+["']https?:\/\/[^"']*["']\s*;?/gi, '')
      .replace(/@import\s+url\(\s*["']?https?:\/\/[^"')]*["']?\s*\)\s*;?/gi, '')
      .replace(/url\(\s*(['"]?)https?:\/\/[^'")]+\1\s*\)/gi, 'url("data:,")');
    return open + stripExternalStyleBlockResources(blocked) + close;
  });

  return out;
}
