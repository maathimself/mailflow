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
export function stripEmailHead(html) {
  if (!html) return html;
  return html.replace(/<head\b[^>]*>([\s\S]*?)<\/head>/gi, (_, headContent) => {
    const noMso = headContent.replace(/<!--\[if[^\]]*\]>[\s\S]*?<!\[endif\]-->/gi, '');
    const styles = noMso.match(/<style\b[^>]*>[\s\S]*?<\/style>/gi) || [];
    return styles.join('');
  });
}

function upgradeUrl(url) {
  return typeof url === 'string' && url.startsWith('http://') ? 'https://' + url.slice(7) : url;
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
  } catch (_) {}
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
      } catch (_) {}
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

// Post-process sanitized HTML to upgrade http:// URLs inside <style> blocks.
// sanitize-html only transforms attributes, not element text content, so <style>
// block CSS must be handled separately after sanitization.
function upgradeStyleBlocks(html) {
  if (!html) return html;
  return html.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (_, open, content, close) => {
    return open + content.replace(/url\(\s*(['"]?)http:\/\//gi, (_, q) => `url(${q}https://`) + close;
  });
}

// Sanitize HTML email body — permissive but safe.
export function sanitizeEmail(html) {
  const sanitized = sanitizeHtml(stripEmailHead(html), {
    allowVulnerableTags: true,
    allowedTags: [
      'html','head','body','div','span','p','br','hr',
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
      // Ensure all links open safely — no opener reference so sites with
      // COOP: same-origin (e.g. Stripe, GitHub) don't show a security warning.
      'a': (tagName, attribs) => ({
        tagName,
        attribs: { ...attribs, rel: 'noopener noreferrer' },
      }),
      // Upgrade http:// → https:// for image sources and inline style url() refs.
      // Many marketing emails still use plain-http image URLs which are blocked as
      // mixed content on an https host, causing images to silently fail.
      'img': (tagName, attribs) => {
        const out = { ...attribs };
        if (out.src)    out.src    = unwrapEbayImgUrl(upgradeUrl(out.src));
        if (out.srcset) out.srcset = out.srcset
          .split(',')
          .map(part => {
            const [url, ...rest] = part.trim().split(/\s+/);
            return [upgradeUrl(url), ...rest].join(' ');
          })
          .join(', ');
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
  return upgradeStyleBlocks(sanitized);
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

// Returns true if the sanitized HTML contains any remote http/https image references.
export function hasRemoteImages(html) {
  if (!html) return false;
  return (
    /<img\b[^>]*\ssrc=["']https?:\/\//i.test(html) ||
    /<img\b[^>]*\ssrcset=["'][^"']*https?:\/\//i.test(html) ||
    /\sbackground=["']https?:\/\//i.test(html) ||
    /url\(\s*['"]?https?:\/\//i.test(html)
  );
}

// Rewrite remote http/https image references so the browser makes no network requests.
// Stores the original URL in data-mailflow-src (img), data-mailflow-srcset (srcset),
// or data-mailflow-bg (background attribute) so the UI can restore them when the user
// chooses to load images.  data: and cid: sources are always left intact.
// Never call this on HTML that will be written back to the database — apply only at
// response time so the canonical cached body remains unmodified.
export function blockRemoteImages(html) {
  if (!html) return html;

  // Block <img src="https://..."> — zero out src, preserve URL in data attribute
  let out = html.replace(
    /(<img\b[^>]*?)\ssrc=(["'])(https?:\/\/[^\s"']*)\2/gi,
    '$1 src=$2$2 data-mailflow-src=$2$3$2'
  );

  // Block img srcset when it contains any remote URLs
  out = out.replace(
    /(<img\b[^>]*?)\ssrcset=(["'])([^"']*)\2/gi,
    (_, pre, q, val) =>
      /https?:\/\//i.test(val)
        ? `${pre} data-mailflow-srcset=${q}${val}${q}`
        : `${pre} srcset=${q}${val}${q}`
  );

  // Block background="https://..." attribute (table-based marketing email layouts)
  out = out.replace(
    /(\s)background=(["'])(https?:\/\/[^\s"']*)\2/gi,
    '$1data-mailflow-bg=$2$3$2 background=$2$2'
  );

  // Block CSS url(https://...) in inline style= attributes (double-quoted by sanitize-html)
  out = out.replace(
    /\sstyle="([^"]*)"/gi,
    (_, styleVal) => {
      const blocked = styleVal.replace(
        /url\(\s*(['"]?)https?:\/\/[^'")]+\1\s*\)/gi,
        'url("")'
      );
      return ` style="${blocked}"`;
    }
  );

  // Block CSS url(https://...) in <style> blocks
  out = out.replace(
    /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi,
    (_, open, content, close) =>
      open + content.replace(
        /url\(\s*(['"]?)https?:\/\/[^'")]+\1\s*\)/gi,
        'url("")'
      ) + close
  );

  return out;
}
