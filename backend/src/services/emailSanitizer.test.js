import { describe, it, expect, vi } from 'vitest';
import { logger } from './logger.js';
import {
  stripEmailHead,
  sanitizeEmail,
  sanitizeSignature,
  sanitizeComposeBody,
  hasRemoteImages,
  blockRemoteImages,
  rewriteEbayImageserUrls,
  rewriteAnchorHrefs,
} from './emailSanitizer.js';

// ── stripEmailHead ─────────────────────────────────────────────────────────

describe('draft signature sanitization', () => {
  it('keeps only the safe div signature marker when requested for draft composition', () => {
    const html = '<p>Reply</p><div data-mailflow-signature="1" onclick="alert(1)"><strong>Thanks</strong><img src="javascript:alert(2)" onerror="alert(3)"><script>alert(4)</script></div><span data-mailflow-signature="1">Quoted</span>';
    const sanitized = sanitizeEmail(html, { preserveDraftSignature: true });
    expect(sanitized).toContain('<div data-mailflow-signature="1">');
    expect(sanitized).toContain('<strong>Thanks</strong>');
    expect(sanitized.match(/data-mailflow-signature/g)).toHaveLength(1);
    expect(sanitized).not.toMatch(/onclick|onerror|javascript:|<script|alert\(4\)/i);
    expect(sanitizeEmail(html)).not.toContain('data-mailflow-signature');
  });

  it('strips global CSS from composer-bound signatures while retaining ordinary email styles', () => {
    const html = '<div data-mailflow-signature="1"><p>Thanks</p><style>body button{display:none!important}</style></div>';
    const sanitized = sanitizeEmail(html, { preserveDraftSignature: true });
    expect(sanitized).toBe('<div data-mailflow-signature="1"><p>Thanks</p></div>');
    expect(sanitizeEmail(html)).toContain('<style>body button{display:none!important}</style>');
  });
});

describe('stripEmailHead', () => {
  it('removes <head> and its text content', () => {
    const html = '<html><head><title>Newsletter</title></head><body>Hello</body></html>';
    expect(stripEmailHead(html)).not.toContain('Newsletter');
    expect(stripEmailHead(html)).not.toContain('<title>');
  });

  it('preserves <style> blocks found inside <head>', () => {
    const html = '<head><style>body { color: red; }</style><title>X</title></head><body/>';
    const out = stripEmailHead(html);
    expect(out).toContain('body { color: red; }');
    expect(out).not.toContain('<title>');
  });

  it('strips MSO conditional comments from head styles', () => {
    const html = '<head><style><!--[if gte mso 9]>mso-only{}<![endif]-->real{}</style></head>';
    const out = stripEmailHead(html);
    expect(out).toContain('real{}');
    expect(out).not.toContain('mso-only');
    expect(out).not.toContain('[if gte mso');
  });

  it('returns falsy input unchanged', () => {
    expect(stripEmailHead('')).toBe('');
    expect(stripEmailHead(null)).toBeNull();
    expect(stripEmailHead(undefined)).toBeUndefined();
  });

  it('leaves HTML with no <head> unchanged', () => {
    const html = '<body><p>Hello</p></body>';
    expect(stripEmailHead(html)).toBe(html);
  });
});

// ── sanitizeEmail ──────────────────────────────────────────────────────────

describe('sanitizeEmail — malformed markup', () => {
  it('keeps the body when </head> comes after </body>', () => {
    const out = sanitizeEmail('<html><head><style>p{color:red}</style><body><p>Je bezorging is bijgewerkt</p></body></head></html>');
    expect(out).toContain('<p>Je bezorging is bijgewerkt</p>');
    expect(out).toContain('p{color:red}');
  });

  it('does not let a stray </td> close a cell of the outer table', () => {
    const out = sanitizeEmail(
      '<table><tr><td><table><tr><td><tr><td>inner</td></tr></td></tr></table>' +
      '<p>outer cell</p></td><td>second cell</td></tr></table>'
    );
    expect(out).toBe(
      '<table><tbody><tr><td><table><tbody><tr><td></td></tr><tr><td>inner</td></tr></tbody></table>' +
      '<p>outer cell</p></td><td>second cell</td></tr></tbody></table>'
    );
  });

  it('still sanitizes markup nested deeper than the HTML5 rebuild allows', () => {
    const out = sanitizeEmail(`<html><body>${'<div>'.repeat(5000)}deep text</body></html>`);
    expect(out).toContain('deep text');
  });

  it('does not re-create unclosed formatting elements in every later paragraph', () => {
    let open = '';
    for (let i = 0; i < 200; i++) open += `<b class="c${i}">`;
    const html = `<html><body><p>${open}</p>${'<p>x</p>'.repeat(500)}</body></html>`;
    const out = sanitizeEmail(html);
    expect(out.match(/<b /g)).toHaveLength(200);
  });

  it('does not show the <title> of a document forwarded inside the body', () => {
    const out = sanitizeEmail(
      '<div>FYI<html><head><title>Your receipt from Example Store</title></head>' +
      '<body><p>Total: $12.00</p></body></html></div>'
    );
    expect(out).not.toContain('Your receipt');
    expect(out).toContain('<p>Total: $12.00</p>');
  });

  it('does not copy a large attribute into every later paragraph', () => {
    const html = `<html><body><p><b data-x="${'A'.repeat(20000)}">x</p>${'<p>x</p>'.repeat(1000)}</body></html>`;
    expect(sanitizeEmail(html).match(/<b>/g)).toHaveLength(1);
  });

  it('gives up when the rebuild would rescan the tree without bound', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      let bodies = '';
      for (let i = 0; i < 2000; i++) bodies += `<body a${i}>`;
      sanitizeEmail(`<html><body>${bodies}x</body></html>`);
      sanitizeEmail(`<table>${'<i></i>'.repeat(2000)}</table>`);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps rebuilding ordinary malformed mail', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      sanitizeEmail(`<html><body>${'<p><font face=Arial size=2>Paragraph text'.repeat(1000)}</body></html>`);
      sanitizeEmail(`<table>${'<tr><td>row</td></tr><br>'.repeat(50)}</table>`);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('sanitizeEmail — XSS prevention', () => {
  it('strips <script> tags and their content', () => {
    const out = sanitizeEmail('<p>Hi</p><script>alert(1)</script>');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('alert(1)');
  });

  it('strips inline event handlers', () => {
    const out = sanitizeEmail('<p onclick="alert(1)">click me</p>');
    expect(out).not.toContain('onclick');
  });

  it('strips javascript: href values', () => {
    const out = sanitizeEmail('<a href="javascript:alert(1)">click</a>');
    expect(out).not.toContain('javascript:');
  });

  it('strips <iframe> tags', () => {
    const out = sanitizeEmail('<iframe src="https://evil.com"></iframe>');
    expect(out).not.toContain('<iframe');
  });

  it('strips <object> and <embed> tags', () => {
    expect(sanitizeEmail('<object data="x.swf"></object>')).not.toContain('<object');
    expect(sanitizeEmail('<embed src="x.swf">')).not.toContain('<embed');
  });
});

describe('sanitizeEmail — link handling', () => {
  it('adds rel="noopener noreferrer" to all links', () => {
    const out = sanitizeEmail('<a href="https://example.com">link</a>');
    expect(out).toContain('rel="noopener noreferrer"');
  });

  it('preserves valid https href', () => {
    const out = sanitizeEmail('<a href="https://example.com">link</a>');
    expect(out).toContain('href="https://example.com"');
  });

  it('preserves mailto href', () => {
    const out = sanitizeEmail('<a href="mailto:user@example.com">email</a>');
    expect(out).toContain('href="mailto:user@example.com"');
  });

  it('upgrades bare domain href to https', () => {
    const out = sanitizeEmail('<a href="benchmade.com">logo</a>');
    expect(out).toContain('href="https://benchmade.com"');
  });

  it('upgrades bare domain with path to https', () => {
    const out = sanitizeEmail('<a href="www.example.com/path?q=1">link</a>');
    expect(out).toContain('href="https://www.example.com/path?q=1"');
  });

  it('upgrades protocol-relative href to https', () => {
    const out = sanitizeEmail('<a href="//example.com/foo">link</a>');
    expect(out).toContain('href="https://example.com/foo"');
  });

  it('upgrades http href to https', () => {
    const out = sanitizeEmail('<a href="http://example.com">link</a>');
    expect(out).toContain('href="https://example.com"');
    expect(out).not.toContain('href="http://');
  });

  it('removes root-relative href', () => {
    const out = sanitizeEmail('<a href="/">home</a>');
    expect(out).not.toContain('href="/"');
  });

  it('removes path-relative href', () => {
    const out = sanitizeEmail('<a href="./page">link</a>');
    expect(out).not.toContain('href="./page"');
  });

  it('removes fragment href', () => {
    const out = sanitizeEmail('<a href="#section">link</a>');
    expect(out).not.toContain('href="#section"');
  });

  it('removes empty href', () => {
    const out = sanitizeEmail('<a href="">link</a>');
    expect(out).not.toContain('href=""');
  });
});

// ── rewriteAnchorHrefs ─────────────────────────────────────────────────────

describe('rewriteAnchorHrefs', () => {
  it('upgrades bare domain href to absolute https', () => {
    const out = rewriteAnchorHrefs('<a href="benchmade.com">logo</a>');
    expect(out).toContain('href="https://benchmade.com"');
  });

  it('upgrades bare domain with path', () => {
    const out = rewriteAnchorHrefs('<a href="www.example.com/foo">x</a>');
    expect(out).toContain('href="https://www.example.com/foo"');
  });

  it('upgrades protocol-relative href', () => {
    const out = rewriteAnchorHrefs('<a href="//example.com">x</a>');
    expect(out).toContain('href="https://example.com"');
  });

  it('removes root-relative href', () => {
    const out = rewriteAnchorHrefs('<a href="/">x</a>');
    expect(out).not.toContain('href="/"');
  });

  it('leaves absolute https href unchanged', () => {
    const html = '<a href="https://example.com">x</a>';
    expect(rewriteAnchorHrefs(html)).toBe(html);
  });

  it('leaves mailto href unchanged', () => {
    const html = '<a href="mailto:a@b.com">x</a>';
    expect(rewriteAnchorHrefs(html)).toBe(html);
  });

  it('handles multiple anchors in one pass', () => {
    const out = rewriteAnchorHrefs(
      '<a href="benchmade.com">logo</a> <a href="https://safe.com">safe</a> <a href="/">bad</a>'
    );
    expect(out).toContain('href="https://benchmade.com"');
    expect(out).toContain('href="https://safe.com"');
    expect(out).not.toContain('href="/"');
  });

  it('returns falsy input unchanged', () => {
    expect(rewriteAnchorHrefs(null)).toBeNull();
    expect(rewriteAnchorHrefs('')).toBe('');
  });
});

describe('sanitizeEmail — image handling', () => {
  it('upgrades http:// img src to https://', () => {
    const out = sanitizeEmail('<img src="http://example.com/img.jpg">');
    expect(out).toContain('src="https://example.com/img.jpg"');
    expect(out).not.toContain('src="http://');
  });

  it('upgrades http:// in srcset to https://', () => {
    const out = sanitizeEmail('<img srcset="http://example.com/img.jpg 2x">');
    expect(out).not.toContain('srcset="http://');
  });

  it('adds loading="lazy" to remote images', () => {
    const out = sanitizeEmail('<img src="https://example.com/img.jpg">');
    expect(out).toContain('loading="lazy"');
  });

  it('does not add loading="lazy" to cid: images', () => {
    const out = sanitizeEmail('<img src="cid:part1@msg">');
    expect(out).not.toContain('loading="lazy"');
  });

  it('does not add loading="lazy" to data: images', () => {
    const out = sanitizeEmail('<img src="data:image/png;base64,abc">');
    expect(out).not.toContain('loading="lazy"');
  });

  it('unwraps eBay imageser URLs to the direct image URL', () => {
    const ebayUrl = 'https://svcs.ebay.com/imageser/1/render?imageUrl=https://i.ebayimg.com/thumb.jpg&w=200';
    const out = sanitizeEmail(`<img src="${ebayUrl}">`);
    expect(out).toContain('i.ebayimg.com');
    expect(out).not.toContain('svcs.ebay.com');
  });
});

describe('sanitizeEmail — CSS upgrades', () => {
  it('upgrades http:// url() in inline styles', () => {
    const out = sanitizeEmail('<div style="background:url(http://example.com/bg.jpg)">x</div>');
    expect(out).not.toContain('url(http://');
    expect(out).toContain('url(https://');
  });

  it('strips external url() in <style> blocks', () => {
    const out = sanitizeEmail('<style>body{background:url(http://example.com/bg.jpg)}</style>');
    expect(out).not.toContain('url(http://');
    expect(out).not.toContain('url(https://');
    expect(out).toContain('url()');
  });

  it('strips quoted and spaced external url() in <style> blocks and keeps data: and cid:', () => {
    const out = sanitizeEmail(`<style>.a{background:URL( "https://t.example/a.gif" )}.b{background:url('http://t.example/b.gif')}.c{background:url(data:image/gif;base64,R0lGOD)}.d{background:url(cid:logo)}</style>`);
    expect(out).toBe('<style>.a{background:url()}.b{background:url()}.c{background:url(data:image/gif;base64,R0lGOD)}.d{background:url(cid:logo)}</style>');
  });
});

describe('sanitizeEmail — dark-mode CSS', () => {
  it('removes prefers-color-scheme: dark media blocks and keeps other media queries', () => {
    const out = sanitizeEmail('<style>@media screen and (max-width:600px){.col{width:100%}}.a{b:c}@media (prefers-color-scheme: dark){.a{b:d}.x{y:z}}.e{f:g}</style><p>x</p>');
    expect(out).toBe('<style>@media screen and (max-width:600px){.col{width:100%}}.a{b:c}.e{f:g}</style><p>x</p>');
  });

  it('removes rules scoped to Outlook [data-og*] dark-mode selectors', () => {
    const out = sanitizeEmail('<style>a[href]{color:red}[data-ogsc] .h{color:#fff !important}[data-ogsb] .h{background:#000}.k{l:m}</style>');
    expect(out).toBe('<style>a[href]{color:red}.k{l:m}</style>');
  });

  it('removes color-scheme declarations and filter: invert()', () => {
    const out = sanitizeEmail('<style>:root{color-scheme:light dark}.r{filter:invert(1) hue-rotate(180deg);s:t}.q{filter:blur(2px)}</style>');
    expect(out).toBe('<style>:root{}.r{s:t}.q{filter:blur(2px)}</style>');
  });
});

// Fastest of two runs so a GC pause or cold JIT cannot flake CI.
function fastestRunMs(fn, runs) {
  let fastest = Infinity;
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    fn();
    fastest = Math.min(fastest, performance.now() - start);
  }
  return fastest;
}

describe('sanitizeEmail — crafted <style> CSS', () => {
  // Each input took 5 to 9 seconds per run when these passes were backtracking regexes.
  it('stays linear on input crafted against each pass', () => {
    // Each input holds the `)`, `{` or `]` its old regex needed, where the regex could not
    // use it, so skipping a pass only when that character is absent still fails here.
    const crafted = {
      url: 'url("https://'.repeat(20000) + ')',
      media: '@media (prefers-color-scheme: dark) '.repeat(1500) + '{',
      outlook: '[data-og '.repeat(2500) + ']{',
      invert: ')' + 'filter:invert('.repeat(60000),
    };
    for (const [name, css] of Object.entries(crafted)) {
      const html = `<style>${css}</style>`;
      expect(fastestRunMs(() => sanitizeEmail(html), 2), name).toBeLessThan(1000);
    }
  });
});

describe('sanitizeEmail — crafted markup against the HTML5 pass', () => {
  it('stays fast on a tag with tens of thousands of attributes', () => {
    // parse5's tokenizer compares each attribute name with every earlier one on the tag,
    // before any tree-adapter hook runs. This took 4 to 5 seconds per run.
    let attrs = '';
    for (let i = 0; i < 60000; i++) attrs += ` a${i}`;
    expect(fastestRunMs(() => sanitizeEmail(`<p${attrs}>x</p>`), 2)).toBeLessThan(1000);
  });
});

// ── hasRemoteImages ────────────────────────────────────────────────────────

describe('hasRemoteImages', () => {
  it('detects https img src', () => {
    expect(hasRemoteImages('<img src="https://example.com/x.jpg">')).toBe(true);
  });

  it('detects http img src', () => {
    expect(hasRemoteImages('<img src="http://example.com/x.jpg">')).toBe(true);
  });

  it('detects https in srcset', () => {
    expect(hasRemoteImages('<img srcset="https://example.com/x.jpg 2x">')).toBe(true);
  });

  it('detects background attribute', () => {
    expect(hasRemoteImages('<table background="https://example.com/bg.jpg">')).toBe(true);
  });

  it('detects url() in CSS', () => {
    expect(hasRemoteImages('<style>div{background:url(https://example.com/bg.jpg)}</style>')).toBe(true);
  });

  it('detects @import with bare URL', () => {
    expect(hasRemoteImages('<style>@import "https://fonts.googleapis.com/css";</style>')).toBe(true);
  });

  it('returns false for no remote images', () => {
    expect(hasRemoteImages('<p>Hello world</p>')).toBe(false);
  });

  it('returns false for cid: images', () => {
    expect(hasRemoteImages('<img src="cid:part1@msg">')).toBe(false);
  });

  it('returns false for data: images', () => {
    expect(hasRemoteImages('<img src="data:image/png;base64,abc">')).toBe(false);
  });

  it('returns false for null/empty', () => {
    expect(hasRemoteImages(null)).toBe(false);
    expect(hasRemoteImages('')).toBe(false);
  });
});

// ── blockRemoteImages ──────────────────────────────────────────────────────

describe('blockRemoteImages', () => {
  it('replaces remote img src with an SVG placeholder', () => {
    const out = blockRemoteImages('<img src="https://example.com/tracker.png">');
    expect(out).toContain('src="data:image/svg+xml,');
    expect(out).not.toContain('example.com');
  });

  it('removes srcset containing remote URLs', () => {
    const out = blockRemoteImages('<img src="data:," srcset="https://example.com/img.jpg 2x">');
    expect(out).not.toContain('srcset=');
  });

  it('preserves srcset that contains no remote URLs', () => {
    const out = blockRemoteImages('<img srcset="cid:part1 2x">');
    expect(out).toContain('srcset=');
  });

  it('blanks remote background attribute', () => {
    const out = blockRemoteImages('<table background="https://example.com/bg.jpg">');
    expect(out).toContain('background=""');
    expect(out).not.toContain('example.com');
  });

  it('blocks url() in inline style attributes', () => {
    const out = blockRemoteImages('<div style="background:url(https://example.com/bg.jpg)">');
    expect(out).not.toContain('example.com');
    expect(out).toContain('url("data:,")');
  });

  it('strips @import in <style> blocks', () => {
    const out = blockRemoteImages('<style>@import "https://fonts.googleapis.com/css"; body{}</style>');
    expect(out).not.toContain('@import');
    expect(out).toContain('body{}');
  });

  it('replaces url() in <style> blocks with data:,', () => {
    const out = blockRemoteImages('<style>div{background:url(https://example.com/bg.jpg)}</style>');
    expect(out).not.toContain('example.com');
    expect(out).toContain('url("data:,")');
  });

  it('leaves cid: images intact', () => {
    const html = '<img src="cid:part1@msg">';
    expect(blockRemoteImages(html)).toContain('src="cid:part1@msg"');
  });

  it('leaves data: images intact', () => {
    const html = '<img src="data:image/png;base64,abc">';
    expect(blockRemoteImages(html)).toContain('src="data:image/png;base64,abc"');
  });

  it('returns null/undefined unchanged', () => {
    expect(blockRemoteImages(null)).toBeNull();
    expect(blockRemoteImages(undefined)).toBeUndefined();
  });
});

// ── rewriteEbayImageserUrls ────────────────────────────────────────────────

describe('rewriteEbayImageserUrls', () => {
  it('rewrites eBay imageser src to the direct imageUrl', () => {
    const html = '<img src="https://svcs.ebay.com/imageser/1/render?imageUrl=https://i.ebayimg.com/t.jpg&amp;w=200">';
    const out = rewriteEbayImageserUrls(html);
    expect(out).toContain('i.ebayimg.com');
    expect(out).not.toContain('svcs.ebay.com');
  });

  it('leaves non-eBay URLs unchanged', () => {
    const html = '<img src="https://example.com/img.jpg">';
    expect(rewriteEbayImageserUrls(html)).toBe(html);
  });

  it('returns HTML without imageser unchanged (fast path)', () => {
    const html = '<p>No images here</p>';
    expect(rewriteEbayImageserUrls(html)).toBe(html);
  });
});

// ── sanitizeComposeBody ────────────────────────────────────────────────────

describe('sanitizeComposeBody', () => {
  it('preserves inline data: images from the compose editor', () => {
    const html = '<p><span style="font-size:14px"><img src="data:image/png;base64,abc123" width="200">test</span></p>';
    const out = sanitizeComposeBody(html);
    expect(out).toContain('src="data:image/png;base64,abc123"');
    expect(out).toContain('test');
  });

  it('preserves https:// images', () => {
    const html = '<img src="https://example.com/photo.jpg" alt="photo">';
    const out = sanitizeComposeBody(html);
    expect(out).toContain('src="https://example.com/photo.jpg"');
    expect(out).toContain('alt="photo"');
  });

  it('strips http:// images (only https and data allowed)', () => {
    const out = sanitizeComposeBody('<img src="http://example.com/tracker.png">');
    expect(out).not.toContain('src="http://');
  });

  it('strips <script> tags', () => {
    const out = sanitizeComposeBody('<p>Hi</p><script>alert(1)</script>');
    expect(out).not.toContain('<script');
    expect(out).toContain('Hi');
  });

  it('returns falsy input unchanged', () => {
    expect(sanitizeComposeBody(null)).toBeNull();
    expect(sanitizeComposeBody('')).toBe('');
  });
});

// ── sanitizeSignature ──────────────────────────────────────────────────────

describe('sanitizeSignature', () => {
  it('strips <script> tags', () => {
    const out = sanitizeSignature('<b>Name</b><script>alert(1)</script>');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('alert(1)');
  });

  it('strips event handlers', () => {
    const out = sanitizeSignature('<b onclick="alert(1)">Name</b>');
    expect(out).not.toContain('onclick');
  });

  it('adds rel and target to links', () => {
    const out = sanitizeSignature('<a href="https://example.com">Site</a>');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain('target="_blank"');
  });

  it('strips http:// links (only https allowed)', () => {
    const out = sanitizeSignature('<a href="http://example.com">link</a>');
    expect(out).not.toContain('href="http://');
  });

  it('allows https:// and mailto: links', () => {
    const out = sanitizeSignature(
      '<a href="https://example.com">web</a> <a href="mailto:a@b.com">email</a>'
    );
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain('href="mailto:a@b.com"');
  });

  it('returns falsy input unchanged', () => {
    expect(sanitizeSignature(null)).toBeNull();
    expect(sanitizeSignature('')).toBe('');
  });
});

// ── outgoing hrefs must survive the send path ───────────────────────────────────────────
//
// A disallowed scheme makes sanitize-html drop the href attribute but keep the <a>, so the
// result renders and styles as a link yet does nothing when clicked. That is worse than
// dropping the anchor outright, because nothing looks wrong until a recipient tries it.
// The composer autolinks a typed bare domain as http:// (Tiptap's defaultProtocol), which
// is precisely the case that used to be gutted.

describe('sanitizeComposeBody link hrefs', () => {
  const hrefOf = (html) => (html.match(/href="([^"]*)"/) || [])[1] ?? null;

  it('upgrades an http:// link instead of stripping its href', () => {
    const out = sanitizeComposeBody('<p><a href="http://example.com">example.com</a></p>');
    expect(hrefOf(out)).toBe('https://example.com');
  });

  it('keeps an https:// link untouched', () => {
    const out = sanitizeComposeBody('<p><a href="https://example.com/x?y=1">x</a></p>');
    expect(hrefOf(out)).toBe('https://example.com/x?y=1');
  });

  it('resolves a bare domain to https', () => {
    const out = sanitizeComposeBody('<p><a href="example.com">example.com</a></p>');
    expect(hrefOf(out)).toBe('https://example.com');
  });

  it('keeps mailto and tel links clickable', () => {
    expect(hrefOf(sanitizeComposeBody('<a href="mailto:a@b.com">m</a>'))).toBe('mailto:a@b.com');
    expect(hrefOf(sanitizeComposeBody('<a href="tel:+15551234">t</a>'))).toBe('tel:+15551234');
  });

  it('never emits an anchor that has lost its href', () => {
    // The actual defect: a styled link with nowhere to go. Either the href survives in a
    // usable form, or normalizeHref rejected it and we expect no href at all.
    for (const href of ['http://example.com', 'https://example.com', 'example.com',
                        'www.example.com/path', 'mailto:a@b.com', 'tel:+15551234']) {
      const out = sanitizeComposeBody(`<p><a href="${href}">text</a></p>`);
      expect(hrefOf(out), `href "${href}" was stripped`).not.toBe(null);
    }
  });

  it('still refuses dangerous and unresolvable hrefs', () => {
    for (const href of ['javascript:alert(1)', 'data:text/html,x', 'vbscript:x', '#anchor', '/relative']) {
      const out = sanitizeComposeBody(`<p><a href="${href}">text</a></p>`);
      expect(hrefOf(out)).toBe(null);
      expect(out).not.toMatch(/javascript:|vbscript:|data:text/i);
    }
  });

  it('applies the same rules to signatures', () => {
    expect(hrefOf(sanitizeSignature('<a href="http://example.com">site</a>'))).toBe('https://example.com');
    expect(hrefOf(sanitizeSignature('<a href="javascript:alert(1)">x</a>'))).toBe(null);
  });
});
