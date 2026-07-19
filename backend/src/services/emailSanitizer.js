import sanitizeHtml from 'sanitize-html';

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
  return scanPaired(html, /<style\b/gi, '</style>', (open, content, close) =>
    open + content.replace(/url\s*\(\s*(['"]?)https?:\/\/[^)]*\1\s*\)/gi, 'url()') + close
  );
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

// Strip dark-mode CSS from a <style> block's text content.
// Targets @media (prefers-color-scheme: dark) blocks, Outlook dark-mode attribute
// selectors, and properties that invert or override the forced-light background.
function stripDarkModeCss(css) {
  // Remove @media (prefers-color-scheme: dark) { ... } blocks.
  // Pattern handles one level of brace nesting (sufficient for email CSS).
  let out = css.replace(
    /@media\b[^{]*prefers-color-scheme\s*:\s*dark[^{]*\{(?:[^{}]|\{[^{}]*\})*\}/gi,
    ''
  );
  // Remove rules scoped to Outlook dark-mode attribute selectors
  // (e.g. [data-ogsc], [data-ogsb]).
  out = out.replace(/\[[^\]]*data-og[^\]]*\][^{]*\{[^}]*\}/gi, '');
  // Strip color-scheme declarations — the iframe meta tag controls this instead.
  out = out.replace(/\bcolor-scheme\s*:[^;!}]+;?/gi, '');
  // Strip filter:invert(...) — used to simulate dark mode by inverting the page,
  // which breaks rendering on our forced-white background.
  out = out.replace(/\bfilter\s*:\s*invert\([^)]*\)[^;]*;?/gi, '');
  return out;
}

function stripDarkModeStyleBlocks(html) {
  if (!html) return html;
  return scanPaired(html, /<style\b/gi, '</style>', (open, content, close) =>
    open + stripDarkModeCss(content) + close
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
        if (out.src)    out.src    = unwrapEbayImgUrl(upgradeUrl(out.src));
        // Simple regex replacement avoids split(',') corrupting data: URIs that
        // contain commas (e.g. data:image/png;base64,abc 2x).
        if (out.srcset) out.srcset = out.srcset.replace(/\bhttp:\/\//g, 'https://');
        if (out.background) out.background = upgradeUrl(out.background);
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
        if (out.background) out.background = upgradeUrl(out.background);
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
  // Then strip dark-mode CSS that would override the forced-light rendering environment.
  return stripDarkModeStyleBlocks(upgradeStyleBlocks(stripExternalStyleBlockUrls(sanitized)));
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

// Returns true if the sanitized HTML contains any remote http/https image references,
// including CSS @import with a bare quoted URL (not wrapped in url()) which bypasses
// the url() pattern check but still causes an outbound stylesheet request.
export function hasRemoteImages(html) {
  if (!html) return false;
  return (
    /<img\b[^>]*\ssrc=["']https?:\/\//i.test(html) ||
    /<img\b[^>]*\ssrcset=["'][^"']*https?:\/\//i.test(html) ||
    /\sbackground=["']https?:\/\//i.test(html) ||
    /url\(\s*['"]?https?:\/\//i.test(html) ||
    /@import\s+["']https?:\/\//i.test(html)
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
    /(<img\b[^>]*?)\ssrc=(["'])(https?:\/\/[^\s"']*)\2/gi,
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
    /(<img\b[^>]*?)\ssrcset=(["'])([^"']*)\2/gi,
    (_, pre, q, val) =>
      /https?:\/\//i.test(val)
        ? pre
        : `${pre} srcset=${q}${val}${q}`
  );

  // Blank background="https://..." attribute (table-based marketing email layouts).
  out = out.replace(
    /(\s)background=(["'])(https?:\/\/[^\s"']*)\2/gi,
    '$1background=$2$2'
  );

  // Block CSS url(https://...) in inline style= attributes.
  out = out.replace(
    /\sstyle="([^"]*)"/gi,
    (_, styleVal) => {
      const blocked = styleVal.replace(
        /url\(\s*(['"]?)https?:\/\/[^'")]+\1\s*\)/gi,
        'url("data:,")'
      );
      return ` style="${blocked}"`;
    }
  );

  // Block remote CSS loads inside <style> blocks:
  // 1. Strip @import "https://..." (bare quoted form — not caught by url() pattern).
  // 2. Strip @import url(https://...) (url() form).
  // 3. Replace remaining url(https://...) CSS property values with data:,.
  out = scanPaired(out, /<style\b/gi, '</style>', (open, content, close) => {
    const blocked = content
      .replace(/@import\s+["']https?:\/\/[^"']*["']\s*;?/gi, '')
      .replace(/@import\s+url\(\s*["']?https?:\/\/[^"')]*["']?\s*\)\s*;?/gi, '')
      .replace(/url\(\s*(['"]?)https?:\/\/[^'")]+\1\s*\)/gi, 'url("data:,")');
    return open + blocked + close;
  });

  return out;
}
