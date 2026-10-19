import { describe, it, expect, vi } from 'vitest';
import { logger } from './logger.js';
import {
  stripEmailHead,
  sealStyleText,
  sanitizeEmail,
  sanitizeSignature,
  sanitizeComposeBody,
  composeHtmlToText,
  hasRemoteImages,
  blockRemoteImages,
  rewriteEbayImageserUrls,
  rewriteAnchorHrefs,
  withoutDarkScheme,
  splitDarkScheme,
  proxyRemoteImages,
  remoteImageRefs,
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
  // #228: the sender's dark design is kept, switched off, for the reader to switch on when it
  // renders the message dark. It must never apply on the light page, as it did in May.
  it('moves prefers-color-scheme: dark blocks into a switched-off style and keeps other media queries', () => {
    const out = sanitizeEmail('<style>@media screen and (max-width:600px){.col{width:100%}}.a{b:c}@media (prefers-color-scheme: dark){.a{b:d}.x{y:z}}.e{f:g}</style><p>x</p>');
    expect(out).toBe('<style>@media screen and (max-width:600px){.col{width:100%}}.a{b:c}.e{f:g}</style><p>x</p>'
      + '<style data-mf-dark-scheme media="not all">@media (min-width: 0px){.a{b:d}.x{y:z}}</style>');
  });

  it("keeps a dark block's other conditions, and collects every block into one style", () => {
    const out = sanitizeEmail('<style>@media (prefers-color-scheme: dark) and (max-width: 600px){.a{color:#fff}}</style>'
      + '<p>y</p><style>@media screen and (prefers-color-scheme:dark){.b{color:#eee}}</style>');
    expect(out).toBe('<style></style><p>y</p><style></style><style data-mf-dark-scheme media="not all">'
      + '@media (min-width: 0px) and (max-width: 600px){.a{color:#fff}}\n@media screen and (min-width: 0px){.b{color:#eee}}</style>');
  });

  it('cleans the moved CSS like the rest: no invert(), Outlook rules or color-scheme', () => {
    const out = sanitizeEmail('<style>@media (prefers-color-scheme: dark){img{filter:invert(1)}[data-ogsc] .h{color:#fff}.k{color-scheme:dark;color:#fff}}</style><p>z</p>');
    expect(out).toBe('<style></style><p>z</p><style data-mf-dark-scheme media="not all">@media (min-width: 0px){img{}.k{color:#fff}}</style>');
  });

  it('adds nothing to a message without dark CSS', () => {
    expect(sanitizeEmail('<style>.a{b:c}</style><p>x</p>')).toBe('<style>.a{b:c}</style><p>x</p>');
  });

  it('marks a message that asks to stay light, in a meta tag or in CSS, and drops its dark CSS', () => {
    for (const html of [
      '<html><head><meta name="color-scheme" content="only light"></head><body><style>@media (prefers-color-scheme: dark){.a{b:d}}</style><p>z</p></body></html>',
      '<html><head><meta content="light only" name="supported-color-schemes"></head><body><p>z</p></body></html>',
      '<style>:root{color-scheme: light only}</style><p>z</p>',
    ]) {
      const out = sanitizeEmail(html);
      expect(out.startsWith('<!--mf-light-only-->'), html).toBe(true);
      expect(out, html).not.toContain('data-mf-dark-scheme');
    }
    expect(sanitizeEmail('<html><head><meta name="color-scheme" content="light dark"></head><body><p>z</p></body></html>'))
      .not.toContain('mf-light-only');
  });

  it('removes rules scoped to Outlook [data-og*] dark-mode selectors', () => {
    const out = sanitizeEmail('<style>a[href]{color:red}[data-ogsc] .h{color:#fff !important}[data-ogsb] .h{background:#000}.k{l:m}</style>');
    expect(out).toBe('<style>a[href]{color:red}.k{l:m}</style>');
  });

  it('removes filter: invert() up to the end of its rule, not into the rules after it', () => {
    const out = sanitizeEmail('<style>img{filter:invert(1)}.keep{color:red;margin:0}.also{x:y}</style>');
    expect(out).toBe('<style>img{}.keep{color:red;margin:0}.also{x:y}</style>');
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
  it('stays linear on <meta> tags crafted against the light-only check', () => {
    const html = '<meta name="color-scheme" content="only light"'.repeat(3000) + '<p>x</p>';
    expect(fastestRunMs(() => sanitizeEmail(html), 2)).toBeLessThan(1000);
  });

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
  // parse5's tokenizer compares each attribute name with every earlier one on its tag, before
  // any tree-adapter hook runs, so the budget cannot stop it. One tag with 26,000 attributes,
  // under the 128 KB cap, took 1.2 s per run; a tag past MAX_ATTRIBUTES_PER_TAG skips the pass.
  const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
  const names = (n) => Array.from({ length: n }, (_, i) => {
    let s = '', x = i;
    for (let k = 0; k < 4; k++) { s += LETTERS[x % 26]; x = Math.floor(x / 26); }
    return s;
  });
  // As many distinct four-letter names as fit under the 128 KB cap.
  const flood = (sep = ' ') => names(25000).join(sep);
  function warnings(fn) {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try { fn(); return warn.mock.calls.length; } finally { warn.mockRestore(); }
  }

  it('stays fast on one tag with tens of thousands of attributes under the size cap', () => {
    const html = `<p ${flood()}>x</p>`;
    expect(html.length).toBeLessThan(128 * 1024);
    let ms;
    expect(warnings(() => { ms = fastestRunMs(() => sanitizeEmail(html), 2); })).toBeGreaterThan(0);
    expect(ms).toBeLessThan(300);
    expect(sanitizeEmail(html)).toBe('<p>x</p>');
  });

  it("counts attributes the way parse5 does: on end tags, after '/', and between quoted values", () => {
    const n = names(600);
    for (const html of [
      `<p>x</p ${n.join(' ')}>`,
      `<p ${n.join('/')}>x</p>`,
      `<p ${n.map(a => `${a}=""`).join('')}>x</p>`,
    ]) expect(warnings(() => sanitizeEmail(html)), html.slice(0, 20)).toBe(1);
  });

  it('cannot be hidden from the count where tags are text to the tree builder', () => {
    // Inside <svg>, <style> holds tags; text that opens a quote inside an HTML <style> or a
    // comment must not make a later real tag look like part of a quoted value.
    const tag = `<p ${names(600).join(' ')}>x</p>`;
    for (const html of [`<svg><style>${tag}</style></svg>`, `<style><x a="</style>${tag}`, `<!-- <x a=" -->${tag}`]) {
      expect(warnings(() => sanitizeEmail(html)), html.slice(0, 20)).toBe(1);
    }
  });

  it('still rebuilds mail whose tags have an ordinary number of attributes', () => {
    // The </head>-after-</body> case only renders if the HTML5 pass runs.
    const attrs = names(400).map(a => `data-${a}="1"`).join(' ');
    const html = `<html><head><style>p{color:red}</style><body><p ${attrs}>visible</p></body></head></html>`;
    let out;
    expect(warnings(() => { out = sanitizeEmail(html); })).toBe(0);
    expect(out).toContain('<p>visible</p>');
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
    expect(out).toContain('url(data:,)');
  });

  it('strips @import in <style> blocks', () => {
    const out = blockRemoteImages('<style>@import "https://fonts.googleapis.com/css"; body{}</style>');
    expect(out).not.toContain('@import');
    expect(out).toContain('body{}');
  });

  it('replaces url() in <style> blocks with data:,', () => {
    const out = blockRemoteImages('<style>div{background:url(https://example.com/bg.jpg)}</style>');
    expect(out).not.toContain('example.com');
    expect(out).toContain('url(data:,)');
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

  // Protocol-relative URLs ("//host/x"): the email frame resolves them to https, so they load like
  // any remote URL and must be blocked like one. They used to slip through every rule.
  it.each([
    ['img src', '<img src="//tracker.example/p.gif" width="1" height="1">'],
    ['img src with leading space', '<img src=" //tracker.example/p.gif">'],
    ['srcset', '<img src="data:," srcset="//tracker.example/b.png 2x">'],
    ['background attribute', '<table background="//tracker.example/bg.png"><tr><td>x</td></tr></table>'],
    ['inline style', '<div style="background:url(//tracker.example/i.png)">x</div>'],
    ['style block', '<style>.h{background:url(//tracker.example/s.png)}</style>'],
    ['style block @import', '<style>@import url(//tracker.example/s.css); p{}</style>'],
  ])('blocks a protocol-relative URL in %s', (_, html) => {
    expect(blockRemoteImages(html)).not.toContain('tracker.example');
  });

  // Sanitized HTML writes a double quote inside an attribute as &quot;, so a URL the email quoted
  // with " was not recognized in an inline style and loaded anyway.
  it('blocks an inline style URL quoted with &quot;', () => {
    const out = blockRemoteImages('<div style="background-image:url(&quot;https://tracker.example/h.png&quot;);background-color:#ffffff">x</div>');
    expect(out).not.toContain('tracker.example');
    expect(out).toBe('<div style="background-image:url(data:,);background-color:#ffffff">x</div>');
  });

  it('blocks a quoted URL that contains parentheses', () => {
    const out = blockRemoteImages('<style>.h{background:url("https://tracker.example/a(1).png")}</style>');
    expect(out).toBe('<style>.h{background:url(data:,)}</style>');
  });

  it('blocks URLs in image-set()', () => {
    const out = blockRemoteImages('<div style="background-image:image-set(&quot;https://tracker.example/a.png&quot; 1x, url(https://tracker.example/b.png) 2x)">x</div>');
    expect(out).not.toContain('tracker.example');
  });

  // The replacement used to be url("data:,"), whose quotes ended the double-quoted style attribute:
  // everything after a blocked background image (its color, the text color, padding) was lost.
  it.each([
    ['unquoted', 'url(https://example.com/h.png)'],
    ['single-quoted', "url('https://example.com/h.png')"],
    ['double-quoted', 'url(&quot;https://example.com/h.png&quot;)'],
  ])('keeps the rest of an inline style after a blocked %s URL', (_, url) => {
    const out = blockRemoteImages(`<div style="background-image:${url};background-color:#ffffff;color:#222222;padding:40px">A</div>`);
    expect(out).toBe('<div style="background-image:url(data:,);background-color:#ffffff;color:#222222;padding:40px">A</div>');
  });

  // An apostrophe in a double-quoted URL used to end the match early: neither blocked nor detected.
  it('blocks a URL holding the other quote character', () => {
    expect(blockRemoteImages(`<img src="https://tracker.example/a'b.png">`)).not.toContain('tracker.example');
    expect(blockRemoteImages(`<table background="https://tracker.example/a'b.png">`)).not.toContain('tracker.example');
    expect(blockRemoteImages(`<img src="data:," srcset="https://tracker.example/a'b.png 2x">`)).not.toContain('tracker.example');
    expect(hasRemoteImages(`<img src="https://tracker.example/a'b.png">`)).toBe(true);
  });

  it('keeps a single-quoted style attribute well formed', () => {
    const out = blockRemoteImages(`<div style='background:url("https://example.com/h.png");color:red'>x</div>`);
    expect(out).toBe('<div style="background:url(data:,);color:red">x</div>');
  });

  it('leaves a style with nothing remote exactly as it was', () => {
    const html = '<div style="font-family:&quot;Helvetica Neue&quot;, Arial;background:url(data:image/png;base64,AAAA)">x</div>';
    expect(blockRemoteImages(html)).toBe(html);
  });

  it('leaves relative and same-page URLs alone', () => {
    const html = '<div style="background:url(/local.png)"><a href="#top">x</a></div><style>p{background:url(img/a.png)}</style>';
    expect(blockRemoteImages(html)).toBe(html);
  });
});

// Detection is defined as "blocking would change something", so the two cannot disagree: a body
// that needs blocking is always detected, and the blocked-images notice always shows for it.
describe('hasRemoteImages and blockRemoteImages agree', () => {
  it.each([
    '<img src="//tracker.example/p.gif">',
    '<table background="//tracker.example/bg.png">',
    '<div style="background:url(&quot;https://tracker.example/h.png&quot;)">x</div>',
    '<div style="background-image:image-set(&quot;https://tracker.example/a.png&quot; 1x)">x</div>',
    '<style>.h{background:url(//tracker.example/s.png)}</style>',
  ])('detects %s', (html) => {
    expect(hasRemoteImages(html)).toBe(true);
    expect(hasRemoteImages(blockRemoteImages(html))).toBe(false);
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

describe('composeHtmlToText', () => {
  const cases = [
    ['paragraphs, and an empty one as a blank line', '<p>A</p><p>B</p><p></p><p>C</p>', 'A\nB\n\nC'],
    ['an empty line written as <p><br></p>', '<p>A</p><p><br></p><p>B</p>', 'A\n\nB'],
    ['entities decoded once', '<p>Fish &amp; chips &lt;b&gt; caf&eacute; &mdash; it&rsquo;s &quot;ok&quot; &#8364;5 &#x1F600;</p>', 'Fish & chips <b> café — it’s "ok" €5 😀'],
    ['literal escaped text stays literal', '<p>Type &amp;amp; for an ampersand</p>', 'Type &amp; for an ampersand'],
    ['line breaks', 'one<br>two<br/>three', 'one\ntwo\nthree'],
    ['a break ending a block adds no blank line, as in a browser', '<p>end<br></p><p>next</p>', 'end\nnext'],
    ['typed spacing kept, source whitespace collapsed', '<div>\n  <p>two&nbsp;&nbsp;spaces\n   here</p>\n</div>', 'two  spaces here'],
    ['text before and after blocks', 'intro<ul><li>x</li><li>y &amp; z</li></ul>tail', 'intro\n- x\n- y & z\ntail'],
    ['nested blocks give one break', 'x<div><div><p>deep</p></div></div>y', 'x\ndeep\ny'],
    ['a rule', '<p>a</p><hr><p>b</p>', 'a\n---\nb'],
    ['table cells on their row', '<table><tr><th>Name</th><th>Qty</th></tr><tr><td>Tea</td><td>2</td></tr></table>', 'Name Qty\nTea 2'],
    ['<pre> keeps its lines and indentation', '<pre><code>if (a &lt; b) {\n    go();\n}</code></pre><p>done</p>', 'if (a < b) {\n    go();\n}\ndone'],
    ['scripts and styles are not text', '<style>p{color:red}</style><p>Visible</p><script>alert(1)</script>', 'Visible'],
    ['control characters in the text do not act as line breaks', '<p>a\u0001b</p><p>c\u0002d</p>', 'ab\ncd'],
    ['nothing', '', ''],
  ];
  for (const [name, html, text] of cases) it(name, () => expect(composeHtmlToText(html)).toBe(text));

  it('stays linear on long runs of spaces', () => {
    // Trimming line ends with /[ \t]+\n/ took 4 s for the first of these.
    for (const html of [`<p>${'&nbsp;'.repeat(100000)}x</p>`, `<pre>${' '.repeat(100000)}x</pre>`]) {
      expect(fastestRunMs(() => composeHtmlToText(html), 2), html.slice(0, 12)).toBeLessThan(1000);
    }
  });
});

describe('withoutDarkScheme', () => {
  it('drops the switched-off dark style and the light-only marker, and nothing else', () => {
    const stored = sanitizeEmail('<style>.a{b:c}@media (prefers-color-scheme: dark){.a{b:d}}</style><p>x</p>');
    expect(withoutDarkScheme(stored)).toBe('<style>.a{b:c}</style><p>x</p>');
    expect(withoutDarkScheme('<!--mf-light-only--><style>.a{b:c}</style><p>x</p>')).toBe('<style>.a{b:c}</style><p>x</p>');
    expect(withoutDarkScheme('<p>plain</p>')).toBe('<p>plain</p>');
    expect(withoutDarkScheme(null)).toBeNull();
  });
});

describe('splitDarkScheme', () => {
  it("separates the email, the sender's dark CSS and the light-only request", () => {
    const stored = sanitizeEmail('<style>.a{b:c}@media (prefers-color-scheme: dark){.a{b:d}}</style><p>x</p>');
    expect(splitDarkScheme(stored)).toEqual({ html: '<style>.a{b:c}</style><p>x</p>', darkCss: '@media (min-width: 0px){.a{b:d}}', lightOnly: false });
    expect(splitDarkScheme(sanitizeEmail('<style>:root{color-scheme: only light}</style><p>x</p>')))
      .toEqual({ html: '<style>:root{}</style><p>x</p>', darkCss: null, lightOnly: true });
    expect(splitDarkScheme('<p>plain</p>')).toEqual({ html: '<p>plain</p>', darkCss: null, lightOnly: false });
    expect(splitDarkScheme(null)).toEqual({ html: null, darkCss: null, lightOnly: false });
  });

  it("never lets the sender's dark CSS load anything remote", () => {
    const { darkCss } = splitDarkScheme(sanitizeEmail('<style>@media (prefers-color-scheme: dark){.a{background:url(https://t.example/pixel.gif)}}</style><p>x</p>'));
    expect(darkCss).not.toContain('t.example');
    expect(darkCss).toContain('url()');
  });
});

// A crafted <style> made every url( pattern scan to the end of the block from each candidate: 40,000
// unclosed url(// held the event loop for half a minute per call, and the body route calls both.
// The CSS scanner now reads the text once; these would take seconds again if that regressed.
describe('remote image blocking stays fast on hostile CSS', () => {
  const n = 40000;
  it.each([
    ['unclosed url(//', `<style>${'a{background:url(//x'.repeat(n)}</style>`],
    ['unclosed quoted url(', `<style>${'a{background:url("//x'.repeat(n)}</style>`],
    ['unclosed image-set(', `<style>${'a{b:image-set("//x" '.repeat(n)}</style>`],
    ['image-set( without strings', `<style>${'a{b:image-set('.repeat(n)}</style>`],
    ['unclosed @import', `<style>${'@import url("//x '.repeat(n)}</style>`],
    ['url( with nothing remote', `<style>${'a{background:url(x'.repeat(n)}</style>`],
  ])('%s', (_, html) => {
    const started = performance.now();
    hasRemoteImages(html);
    blockRemoteImages(html);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

// Searching a lowercased copy put positions off by one per İ (its lowercase is two characters), so
// in Turkish mail a later <style> could be skipped and text cut at the wrong place.
describe('text whose lowercase is longer', () => {
  const many = 'İ'.repeat(30);

  it('still blocks the remote URL in a later style block, and keeps the text around it', () => {
    const html = `<p>${many}</p><style>.a{color:red}</style><p>between</p><style>.h{background:url(//x.example/a.png)}</style><p>after</p>`;
    const out = blockRemoteImages(html);
    expect(out).not.toContain('x.example');
    expect(out).toBe(`<p>${many}</p><style>.a{color:red}</style><p>between</p><style>.h{background:url(data:,)}</style><p>after</p>`);
  });

  it('strips an Outlook-only block from the head without eating what follows', () => {
    const out = stripEmailHead(`<html><head><title>${many}</title><!--[if mso]><style>.m{}</style><![endif]--><style>.keep{color:blue}</style></head><body>x</body></html>`);
    expect(out).not.toContain('.m{}');
    expect(out).toContain('<style>.keep{color:blue}</style>');
  });
});

it('keeps &lt; and &gt; in an inline style it rewrites', () => {
  const html = '<div style="background:url(https://example.com/a.png);font-family:&quot;A&lt;B&gt;&quot;">x</div>';
  expect(blockRemoteImages(html)).toBe('<div style="background:url(data:,);font-family:&quot;A&lt;B&gt;&quot;">x</div>');
});

// The image proxy's rewrite (services/imageProxy.js). A proxy URL carries the reference exactly as
// written, so the original HTML comes back byte for byte (the frontend does this for replies).
describe('proxyRemoteImages', () => {
  const toProxy = (raw) => `/api/mail/messages/m1/image?u=${encodeURIComponent(raw).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`;
  const restore = (html) => html.replace(/\/api\/mail\/messages\/m1\/image\?u=([A-Za-z0-9%._~-]*)/g, (_, u) => decodeURIComponent(u));
  const CASES = {
    img: '<img src="https://img.example/a.png?x=1&amp;y=2" width="10">',
    protocolRelative: '<img src=" //img.example/p.gif">',
    srcset: '<img src="data:image/png;base64,AAAA" srcset="https://img.example/a.png 1x, //img.example/b.png 2x">',
    // A comma inside a URL is part of it, as the browser reads a srcset (Cloudinary transforms).
    srcsetCommas: '<img srcset="https://img.example/c/w_100,h_50/a.png 1x,https://img.example/c/w_200,h_100/a.png 2x">',
    background: '<table background="https://img.example/bg.png"><tr><td>x</td></tr></table>',
    inlineQuoted: '<div style="background-image:url(&quot;https://img.example/h.png?a=1&amp;b=2&quot;);color:#222">x</div>',
    inlineSingle: '<div style="background:url(\'https://img.example/s.png\') no-repeat">x</div>',
    imageSet: '<div style="background-image:image-set(&quot;https://img.example/1.png&quot; 1x, url(https://img.example/2.png) 2x)">x</div>',
    styleBlock: '<style>.h{background:url( "https://img.example/st.png" )}.k{background:url(//img.example/k.png)}</style><div class="h">x</div>',
    untouched: '<img src="data:image/png;base64,AAAA"><img src="cid:part1"><div style="background:url(/local.png);font-family:&quot;A&lt;B&gt;&quot;">x</div>',
  };

  it.each(Object.entries(CASES))('%s: proxied, then restored exactly', (name, html) => {
    const proxied = proxyRemoteImages(html, toProxy);
    expect(proxied).not.toMatch(/(?:https?:)?\/\/img\.example/);
    expect(restore(proxied)).toBe(html);
    if (name === 'untouched') expect(proxied).toBe(html);
  });

  it('leaves nothing for blocking to block', () => {
    for (const html of Object.values(CASES)) {
      const proxied = proxyRemoteImages(html, toProxy);
      expect(blockRemoteImages(proxied)).toBe(proxied);
    }
  });

  it('writes proxy URLs that are safe in any attribute or CSS', () => {
    const proxied = proxyRemoteImages(`<img src="https://img.example/a'b(c)*!.png?q=&quot;x&quot;">`, toProxy);
    const url = /src="([^"]*)"/.exec(proxied)[1];
    expect(url).toMatch(/^\/api\/mail\/messages\/m1\/image\?u=[A-Za-z0-9%._~-]+$/);
  });

  it('leaves remote @imports alone: stylesheets, not images, and never loaded by the frame', () => {
    const html = '<style>@import url(https://fonts.example/a.css); p{}</style>';
    expect(proxyRemoteImages(html, toProxy)).toBe(html);
  });

  it('stays fast on hostile CSS', () => {
    const started = performance.now();
    proxyRemoteImages(`<style>${'a{background:url(//x'.repeat(40000)}</style>`, toProxy);
    proxyRemoteImages(`<style>${'a{b:image-set("//x" '.repeat(40000)}</style>`, toProxy);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe('remoteImageRefs', () => {
  it('maps each reference as written to the URL it loads', () => {
    const refs = remoteImageRefs('<img src="https://img.example/a.png?x=1&amp;y=2"><img src="//img.example/b.png"><div style="background:url(&quot;https://img.example/c.png&quot;)">x</div><style>.s{background:url(https://img.example/d.png)}</style>');
    expect(Object.fromEntries(refs)).toEqual({
      'https://img.example/a.png?x=1&amp;y=2': 'https://img.example/a.png?x=1&y=2',
      '//img.example/b.png': 'https://img.example/b.png',
      'https://img.example/c.png': 'https://img.example/c.png',
      'https://img.example/d.png': 'https://img.example/d.png',
    });
  });

  it('has nothing for cid:, data: or relative images', () => {
    expect(remoteImageRefs('<img src="cid:a"><img src="data:image/png;base64,AAAA"><img src="/x.png">').size).toBe(0);
  });
});

// The clean-ups that run on <style> text after sanitize-html delete parts of the CSS, and a deletion
// joins the text around it: `</` before a removed declaration and `style>` after it made a real end
// tag, so CSS text the allowlist never saw as markup came out of the sanitizer as markup.
describe('style blocks stay closed after the dark-mode and URL clean-ups', () => {
  const ELEMENTS = /<(a|form|input|base|img)\b/i;
  // The markup outside every <style> block, where the HTML parser would build elements.
  const outsideStyles = (html) => {
    let out = '';
    let pos = 0;
    const open = /<style\b[^>]*>/gi;
    let m;
    while ((m = open.exec(html))) {
      out += html.slice(pos, m.index);
      const close = html.toLowerCase().indexOf('</style', open.lastIndex);
      pos = close === -1 ? html.length : html.indexOf('>', close) + 1;
      open.lastIndex = pos;
    }
    return out + html.slice(pos);
  };

  it.each([
    ['an invert() filter', '<style>p{color:red}</filter:invert(1);style><a href="javascript:alert(1)">x</a><form action=https://evil.example><input name=p></form><base href="https://evil.example/"></style><p>after</p>'],
    ['a color-scheme declaration', '<style>p{color:red}</color-scheme:dark;style><img src=x onerror=alert(1)><base href="https://evil.example/"></style><p>after</p>'],
    ['a dark @media block', '<style>p{color:red}</@media (prefers-color-scheme: dark){p{color:#fff}}style><a href="javascript:alert(1)">x</a></style><p>after</p>'],
    ['an external url()', '<style>p{color:red}</url(https://evil.example/x.png)style><a href="javascript:alert(1)">x</a></style><p>after</p>'],
  ])('removing %s cannot close the block early', (_label, html) => {
    const out = sanitizeEmail(html);
    expect(outsideStyles(out)).not.toMatch(ELEMENTS);
    expect(out).toContain('<p>after</p>');
  });

  it('the dark block MailFlow appends cannot be faked from an email\'s own CSS', () => {
    const out = sanitizeEmail('<p>secret text</p><style>/* <style data-mf-dark-scheme media="not all"> */ p{color:red}</style>');
    const { html, darkCss } = splitDarkScheme(out);
    expect(darkCss).toBeNull();
    expect(html).toContain('<p>secret text</p>');
    expect(html).toMatch(/<\/style>$/);
  });

  it('sealing leaves ordinary CSS as it was', () => {
    expect(sealStyleText('p{color:red} a:hover{color:blue}')).toBe('p{color:red} a:hover{color:blue}');
    expect(sealStyleText('x</STYLE')).toBe('x<\\/STYLE');
    expect(sealStyleText('<style')).toBe('<\\style');
  });
});

// The URL standard drops tabs and line breaks inside a URL and trims control characters from its
// ends. An image written `ht&#x0A;tps://…` was not recognized by remote-image blocking or the
// proxy, while the browser still fetched it from the sender.
describe('image URLs are read as the browser reads them', () => {
  it.each([
    ['a line break in the scheme', '<img src="ht&#x0A;tps://evil.example/a.gif">'],
    ['a tab and a leading space', '<img src=" &#x09;https://evil.example/a.gif">'],
    ['a carriage return in a background', '<table><tr><td background="ht&#x0D;tps://evil.example/a.gif">x</td></tr></table>'],
  ])('%s is blocked like any remote image', (_label, html) => {
    const out = sanitizeEmail(html);
    expect(out).toContain('https://evil.example/a.gif');
    expect(blockRemoteImages(out)).not.toContain('evil.example');
  });
});

// #640: an embedded cid: or Content-Location background is a data: URI, which the background
// attribute dropped, taking the newsletter's header image with it.
describe('sanitizeEmail data: backgrounds', () => {
  const png = 'data:image/png;base64,iVBORw0KGgo=';

  it('keeps a base64 raster image in the background of a table, row or cell', () => {
    const out = sanitizeEmail(`<table background="${png}"><tr background="data:image/JPEG;base64,/9j/"><td background="${png}">x</td></tr></table>`);
    expect(out).toContain(`<table background="${png}">`);
    expect(out).toContain('<tr background="data:image/JPEG;base64,/9j/">');
    expect(out).toContain(`<td background="${png}">`);
  });

  it('drops any other data: background, and data: on other tags', () => {
    for (const value of [
      'data:image/svg+xml;base64,PHN2Zz4=',
      'data:text/html;base64,PHNjcmlwdD4=',
      'data:image/png,<svg onload=alert(1)>',
      'data:image/png;base64,AA" onload="alert(1)',
      ' data:application/javascript;base64,YWxlcnQoMSk=',
    ]) {
      const out = sanitizeEmail(`<table background='${value}'><tr><td>x</td></tr></table>`);
      expect(out).not.toContain('background=');
    }
    expect(sanitizeEmail(`<div background="${png}">x</div>`)).not.toContain('background=');
    expect(sanitizeEmail('<td background="javascript:alert(1)">x</td>')).not.toContain('background=');
  });

  it('still upgrades a remote background to https', () => {
    expect(sanitizeEmail('<table background="http://example.com/bg.jpg"><tr><td>x</td></tr></table>'))
      .toContain('background="https://example.com/bg.jpg"');
  });
});
