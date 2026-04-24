import sanitizeHtml from 'sanitize-html';

// Strip the <head> element from email HTML, preserving any <style> blocks inside it.
//
// Why: sanitize-html's 'discard' mode removes disallowed tags (e.g. <title>) but
// keeps their text content.  Non-whitespace text inside <head> is moved to <body>
// by the HTML5 parser (it treats it as an implicit body-start), so text like
// "Document" or "Buffalo Tech Systems" from a <title> tag renders visibly at the
// top of the email.  Stripping <head> entirely (while rescuing <style> blocks, which
// contain layout CSS) prevents this and has no effect on the visible email content.
export function stripEmailHead(html) {
  if (!html) return html;
  return html.replace(/<head\b[^>]*>([\s\S]*?)<\/head>/gi, (_, headContent) => {
    const styles = headContent.match(/<style\b[^>]*>[\s\S]*?<\/style>/gi) || [];
    return styles.join('');
  });
}

// Sanitize HTML email body — permissive but safe.
export function sanitizeEmail(html) {
  return sanitizeHtml(stripEmailHead(html), {
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
              'srcset', 'sizes'],
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
      // Upgrade http:// → https:// for image sources.  Many marketing emails
      // still use plain-http image URLs which are blocked as mixed content on
      // an https host, causing the images to silently fail.
      'img': (tagName, attribs) => {
        const upgrade = url => (typeof url === 'string' && url.startsWith('http://'))
          ? 'https://' + url.slice(7)
          : url;
        const out = { ...attribs };
        if (out.src)    out.src    = upgrade(out.src);
        if (out.srcset) out.srcset = out.srcset
          .split(',')
          .map(part => {
            const [url, ...rest] = part.trim().split(/\s+/);
            return [upgrade(url), ...rest].join(' ');
          })
          .join(', ');
        if (out.background) out.background = upgrade(out.background);
        return { tagName, attribs: out };
      },
    },
    allowedSchemes: ['http', 'https', 'mailto', 'cid', 'data'],
    allowedSchemesByTag: {
      img: ['http', 'https', 'cid', 'data'],
    },
    disallowedTagsMode: 'discard',
  });
}
