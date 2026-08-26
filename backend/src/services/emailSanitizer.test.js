import { describe, it, expect } from 'vitest';
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

  it('normalizes external browser-compatible href spellings without granting a base to relative links', () => {
    const out = sanitizeEmail(`<a id="http" href="http:tracker.invalid/path">http</a>
      <a id="slashes" href="\\\\tracker.invalid\\path">slashes</a>
      <a id="same-scheme" href="https:tracker.invalid/path">same scheme</a>
      <a id="root" href="/api/probe">root</a>`);

    expect(out).toContain('href="https://tracker.invalid/path"');
    expect(out.match(/href=/g)).toHaveLength(2);
    expect(out).not.toContain('/api/probe');
    expect(out).not.toContain('https:tracker.invalid');
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

  it('upgrades protocol-relative image and background attributes to https', () => {
    const out = sanitizeEmail('<img src="//tracker.invalid/src.png" srcset="//tracker.invalid/srcset.png 2x"><table background="//tracker.invalid/background.png"></table>');

    expect(out).toContain('src="https://tracker.invalid/src.png"');
    expect(out).toContain('srcset="https://tracker.invalid/srcset.png 2x"');
    expect(out).toContain('background="https://tracker.invalid/background.png"');
    expect(out).not.toContain('="//tracker.invalid');
  });

  for (const [name, source] of [
    ['backslash network path', '\\\\tracker.invalid\\a.png'],
    ['backslash-slash network path', '\\/tracker.invalid/a.png'],
    ['slash-backslash network path', '/\\tracker.invalid/a.png'],
    ['leading ASCII whitespace', ' \thttps://tracker.invalid/space.png'],
    ['backslashed http scheme', 'http:\\\\tracker.invalid/http.png'],
    ['backslashed https scheme', 'https:\\\\tracker.invalid/https.png'],
  ]) {
    it(`normalizes URL-parser-compatible ${name} image sources`, () => {
      const out = sanitizeEmail(`<img src="${source}">`);

      expect(out).toContain('src="https://tracker.invalid/');
    });
  }

  it('normalizes browser-compatible scheme controls and scheme-relative http URLs', () => {
    const out = sanitizeEmail('<img alt="scheme" src="http:tracker.invalid/no-slashes.png"><img alt="controls" src="h\tt\nt\rps://tracker.invalid/controls.png">');

    expect(out).toContain('src="https://tracker.invalid/no-slashes.png"');
    expect(out).toContain('src="https://tracker.invalid/controls.png"');
  });

  it('drops image resources that would resolve against an application base', () => {
    const out = sanitizeEmail(`<img alt="root" src="/api/probe?src">
      <img alt="path" src="local.png">
      <img alt="same-scheme-relative" src="https:tracker.invalid/same-scheme.png">
      <table background="/api/probe?background"><tbody><tr><td>x</td></tr></tbody></table>`);

    expect(out).not.toContain('/api/probe');
    expect(out).not.toContain('local.png');
    expect(out).not.toContain('same-scheme.png');
    expect(out).not.toContain(' background=');
  });

  it('preserves data URL commas but drops a srcset containing a later unsafe candidate', () => {
    const safe = sanitizeEmail('<img srcset="data:image/png;base64,AAAA 1x, https://images.invalid/two.png 2x">');
    const unsafe = sanitizeEmail('<img srcset="data:image/png;base64,AAAA 1x, /api/probe?later 2x">');

    expect(safe).toContain('srcset="data:image/png;base64,AAAA 1x, https://images.invalid/two.png 2x"');
    expect(unsafe).not.toContain('srcset=');
    expect(unsafe).not.toContain('/api/probe');
  });

  it('does not hide a later srcset candidate in a descriptor-less data URL', () => {
    const unsafe = sanitizeEmail('<img srcset="data:image/png;base64,AAAA, /api/probe?later 2x">');

    expect(unsafe).not.toContain('srcset=');
    expect(unsafe).not.toContain('/api/probe');
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
    expect(out).toContain('url(&quot;https://');
  });

  it('strips external url() in <style> blocks', () => {
    const out = sanitizeEmail('<style>body{background:url(http://example.com/bg.jpg)}</style>');
    expect(out).not.toContain('url(http://');
    expect(out).not.toContain('url(https://');
    expect(out).toContain('url()');
  });

  it('neutralizes inline image-set resources before attribute serialization', () => {
    const out = sanitizeEmail(`<div style="color:red;padding:4px;background-image:image-set('https://tracker.invalid/plain.png' 1x)">plain</div>
      <div style="color:blue;background-image:image-set(&quot;https://tracker.invalid/entity.png&quot; 1x)">entity</div>
      <div style="--candidate:'https://tracker.invalid/var.png' 1x;background-image:image-set(var(--candidate));margin:2px">var</div>
      <div style="display:block;background-image:-webkit-image-set('https://tracker.invalid/legacy.png' 1x)">legacy</div>`);

    expect(out).not.toContain('tracker.invalid/plain.png');
    expect(out).not.toContain('tracker.invalid/entity.png');
    expect(out).not.toContain('tracker.invalid/legacy.png');
    expect(out).not.toContain('image-set(var(');
    expect(out).toContain('color:red');
    expect(out).toContain('padding:4px');
    expect(out).toContain('margin:2px');
    expect(out).toContain('display:block');
  });

  it('neutralizes inline image-set resources on specifically transformed links', () => {
    const out = sanitizeEmail(`<a href="https://example.com" style="color:red;background-image:image-set('https://tracker.invalid/link.png' 1x)">link</a>`);

    expect(out).not.toContain('tracker.invalid/link.png');
    expect(out).toContain('color:red');
    expect(out).toContain('href="https://example.com"');
  });

  it('keeps upgrading ordinary inline http url() resources', () => {
    const out = sanitizeEmail('<div style="color:red;background:url(http://example.com/bg.jpg);padding:4px">x</div>');

    expect(out).toContain('url(&quot;https://example.com/bg.jpg&quot;)');
    expect(out).toContain('color:red');
    expect(out).toContain('padding:4px');
  });

  it('serializes decoded CSS-string quotes without creating a second declaration', () => {
    const style = String.raw`background-image:url('https://safe.invalid/a\27 );background-image:url(/api/probe?x);x:url(\27 safe')`;
    const out = sanitizeEmail(`<div class="css-escape" style="${style}">x</div>`);

    expect(out).toContain('safe.invalid');
    expect(out).not.toContain("url('https://safe.invalid/a');background-image:url(/api/probe?x)");
  });

  it('upgrades inline protocol-relative url() and strips style-block protocol-relative loads', () => {
    const out = sanitizeEmail(`<div style="color:red;background:url(//tracker.invalid/inline.png)">x</div>
      <style>.remote{background:url(//tracker.invalid/block.png)}@import "//tracker.invalid/theme.css";</style>`);

    expect(out).toContain('url(&quot;https://tracker.invalid/inline.png&quot;)');
    expect(out).toContain('color:red');
    expect(out).not.toContain('tracker.invalid/block.png');
    expect(out).not.toContain('tracker.invalid/theme.css');
  });

  it('drops app-relative and invalid ordinary inline resources on wildcard and link transforms', () => {
    const out = sanitizeEmail(`<div style="color:red;background:url(/api/probe?div);border-image:url(local.png) 1">div</div>
      <a href="https://example.com" style="color:blue;background:url(https:tracker.invalid/same-scheme.png)">link</a>`);

    expect(out).not.toContain('/api/probe');
    expect(out).not.toContain('local.png');
    expect(out).not.toContain('same-scheme.png');
    expect(out).toContain('color:red');
    expect(out).toContain('color:blue');
    expect(out).toContain('href="https://example.com"');
  });
});

describe('sanitizeEmail — appearance CSS', () => {
  it('preserves safe light/dark media rules and color-scheme declarations', () => {
    const out = sanitizeEmail(`<style>
      :root { color-scheme: light dark; }
      @media (prefers-color-scheme: dark) {
        .card { color: #eee; background-color: #111; }
      }
      @media (prefers-color-scheme: light) { .card { color: #111; } }
    </style><div class="card">Readable</div>`);

    expect(out).toContain('prefers-color-scheme: dark');
    expect(out).toContain('prefers-color-scheme: light');
    expect(out).toContain('color-scheme: light dark');
    expect(out).toContain('background-color: #111');
  });

  it('preserves Outlook selectors and authored inversion filters', () => {
    const out = sanitizeEmail(
      '<style>[data-ogsc] .logo { filter: invert(1); } [data-ogsb] { background:#000; }</style>',
    );
    expect(out).toContain('data-ogsc');
    expect(out).toContain('data-ogsb');
    expect(out).toContain('filter: invert(1)');
  });

  it('still strips external URLs nested inside dark-mode rules', () => {
    const out = sanitizeEmail(
      '<style>@media (prefers-color-scheme: dark) { .x { background:url(https://tracker.invalid/p.gif); } }</style>',
    );
    expect(out).toContain('prefers-color-scheme: dark');
    expect(out).toContain('url()');
    expect(out).not.toContain('tracker.invalid');
  });

  it('strips quoted external imports without deleting adjacent dark rules', () => {
    const out = sanitizeEmail(`<style>
      @import "https://tracker.invalid/theme.css" screen;
      @media (prefers-color-scheme: dark) { .x { color:white; } }
    </style><p class="x">Readable</p>`);
    expect(out).not.toContain('@import');
    expect(out).not.toContain('tracker.invalid');
    expect(out).toContain('prefers-color-scheme: dark');
  });

  it('does not treat import-like text in CSS strings or comments as an at-rule', () => {
    const css = '.a::before { content: "@import https://tracker.invalid/theme.css"; color:red; } /* @import https://tracker.invalid/theme.css; */ .safe{color:blue}';
    const out = sanitizeEmail(`<style>${css}</style>`);

    expect(out).toContain(css);
  });

  it('strips external quoted url() values containing a closing parenthesis', () => {
    const out = sanitizeEmail(
      '<style>.x { background:url("https://tracker.invalid/p).gif"); }</style>',
    );

    expect(out).toContain('url()');
    expect(out).not.toContain('tracker.invalid');
  });

  it('strips escaped import and URL tokens with external URLs', () => {
    const out = sanitizeEmail(
      '<style>@\\69mport "https://tracker.invalid/theme.css"; .x { background:url("h\\74tps://tracker.invalid/p.gif"); }</style>',
    );

    expect(out).not.toContain('@\\69mport');
    expect(out).not.toContain('tracker.invalid');
    expect(out).toContain('url()');
  });

  it('strips external resources whose escaped scheme uses CSS line continuations', () => {
    const out = sanitizeEmail('<style>.lf{background:url("h\\\nttps://tracker.invalid/lf.gif")} @import "h\\\r\nttps://tracker.invalid/crlf.css"; @import "h\\\fttps://tracker.invalid/ff.css";</style>');

    expect(out).toContain('url()');
    expect(out).not.toContain('tracker.invalid');
  });

  it('strips external resources whose hexadecimal escape has a CRLF terminator', () => {
    const out = sanitizeEmail('<style>.x{background:url("h\\74\r\ntps://tracker.invalid/p.gif")} @import "h\\74\r\ntps://tracker.invalid/theme.css";</style>');

    expect(out).toContain('url()');
    expect(out).not.toContain('tracker.invalid');
  });

  it('strips external quoted image-set candidates while preserving local candidates', () => {
    const out = sanitizeEmail(`<style>
      .plain { background-image:image-set("https://tracker.invalid/plain.png" 1x, "data:image/png;base64,AAAA" 2x); }
      .legacy { background-image:-webkit-image-set( /* candidate */ "h\\74tps://tracker.invalid/escaped.png" 1x, 'cid:logo' 2x); }
      @media (prefers-color-scheme: dark) {
        .nested { background:image-set( 'h\\
ttps://tracker.invalid/dark.png' 1x, "local.png" 2x, linear-gradient(#000,#111) 3x); }
      }
    </style>`);

    expect(out).not.toContain('tracker.invalid');
    expect(out).toContain('data:image/png;base64,AAAA');
    expect(out).toContain('cid:logo');
    expect(out).not.toContain('local.png');
    expect(out).toContain('linear-gradient');
  });

  it('does not treat image-set-like identifiers or nested metadata strings as image candidates', () => {
    const css = '.near { background:not-image-set("https://safe.invalid/near.png"); } .typed { background:image-set(url(data:image/png;base64,AAAA) type("image/png") 1x); }';
    expect(sanitizeEmail(`<style>${css}</style>`)).toContain(css);
  });

  it('neutralizes custom-property substitution inside image-set functions', () => {
    const out = sanitizeEmail(`<style>
      .direct { --candidate:"https://tracker.invalid/v.png" 1x; background:image-set(var(--candidate)); }
      .fallback { background:image-set(var(--missing,"https://tracker.invalid/f.png" 1x)); }
      .escaped { background:-webkit-image-set(/* nested */ type(v\\61r /* gap */ (--candidate))); }
    </style>`);

    expect(out).not.toContain('image-set(var(');
    expect(out).not.toContain('v\\61r');
    expect(out.match(/background:url\(\)/g)).toHaveLength(3);
    expect(out).toContain('--candidate:"https://tracker.invalid/v.png" 1x');
  });

  it('scans hostile unterminated image-set input within a bounded time', () => {
    const css = `.x{background:image-set(${`"safe-${'a'.repeat(32)}",`.repeat(2_000)}`;
    const started = performance.now();
    sanitizeEmail(`<style>${css}</style>`);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('scans many inline image functions and quote entities within a bounded time', () => {
    const declarations = `background-image:image-set(&quot;local.png&quot; 1x);`.repeat(2_000);
    const started = performance.now();
    const out = sanitizeEmail(`<div style="color:red;${declarations}">x</div>`);

    expect(out).not.toContain('local.png');
    expect(out).toContain('color:red');
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('preserves url-like suffixes that are part of a larger identifier', () => {
    const css = '.safe { background:foo-url(https://safe.invalid/a); }';
    expect(sanitizeEmail(`<style>${css}</style>`)).toContain(css);
  });

  it('scans a large safe selector within a bounded time', () => {
    const css = `.${'a'.repeat(16_000)} { color: blue; }`;
    const started = performance.now();
    const out = sanitizeEmail(`<style>${css}</style>`);

    expect(out).toContain(css);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('keeps active-content protections while preserving appearance CSS', () => {
    const out = sanitizeEmail(
      '<script>alert(1)</script><style>@media (prefers-color-scheme:dark){.x{color:white}}</style><p onclick="alert(2)">x</p>',
    );
    expect(out).not.toContain('<script');
    expect(out).not.toContain('onclick');
    expect(out).toContain('prefers-color-scheme:dark');
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

  it('preserves a data URL comma while detecting an unsafe later srcset candidate', () => {
    const html = '<img srcset="data:image/png;base64,AAAA 1x, /api/probe?later 2x">';

    expect(hasRemoteImages(html)).toBe(true);
    expect(blockRemoteImages(html)).not.toContain('srcset=');
  });

  it('detects a remote candidate after a descriptor-less data URL', () => {
    const html = '<img srcset="data:image/png;base64,AAAA, https://tracker.invalid/pixel.png 2x">';

    expect(hasRemoteImages(html)).toBe(true);
    expect(blockRemoteImages(html)).not.toContain('srcset=');
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

  for (const [name, style] of [
    ['quoted image-set', "background-image:image-set('https://tracker.invalid/plain.png' 1x)"],
    ['entity-quoted image-set', 'background-image:image-set(&quot;https://tracker.invalid/entity.png&quot; 1x)'],
    ['variable-fed image-set', "--candidate:'https://tracker.invalid/var.png' 1x;background-image:image-set(var(--candidate))"],
    ['legacy image-set', "background-image:-webkit-image-set('https://tracker.invalid/legacy.png' 1x)"],
  ]) {
    it(`detects legacy inline ${name} resources before the route guard`, () => {
      expect(hasRemoteImages(`<div style="${style}">x</div>`)).toBe(true);
    });
  }

  for (const [name, html] of [
    ['img src', '<img src="//tracker.invalid/src.png">'],
    ['img srcset', '<img srcset="//tracker.invalid/srcset.png 1x">'],
    ['background attribute', '<table background="//tracker.invalid/background.png"></table>'],
    ['inline url()', '<div style="background:url(//tracker.invalid/inline.png)"></div>'],
    ['style-block url()', '<style>.x{background:url(//tracker.invalid/block.png)}</style>'],
    ['style-block import', '<style>@import "//tracker.invalid/theme.css";</style>'],
  ]) {
    it(`detects legacy protocol-relative ${name} before the route guard`, () => {
      expect(hasRemoteImages(html)).toBe(true);
    });
  }

  for (const [name, source] of [
    ['backslash network path', '\\\\tracker.invalid\\a.png'],
    ['backslash-slash network path', '\\/tracker.invalid/a.png'],
    ['slash-backslash network path', '/\\tracker.invalid/a.png'],
    ['leading ASCII whitespace', ' \thttps://tracker.invalid/space.png'],
    ['backslashed http scheme', 'http:\\\\tracker.invalid/http.png'],
    ['backslashed https scheme', 'https:\\\\tracker.invalid/https.png'],
    ['scheme without slashes', 'http:tracker.invalid/no-slashes.png'],
    ['embedded URL-parser controls', 'h\tt\nt\rps://tracker.invalid/controls.png'],
    ['root-relative app origin', '/api/probe'],
  ]) {
    it(`detects URL-parser-compatible ${name} before the route guard`, () => {
      expect(hasRemoteImages(`<img src="${source}">`)).toBe(true);
    });
  }

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
    expect(out).toContain('url(&quot;data:,&quot;)');
  });

  it('neutralizes legacy inline image-set resources while preserving adjacent CSS', () => {
    const html = `<div style="color:red;padding:4px;background-image:image-set('https://tracker.invalid/plain.png' 1x)">plain</div>
      <div style="color:blue;background-image:image-set(&quot;https://tracker.invalid/entity.png&quot; 1x)">entity</div>
      <div style="--candidate:'https://tracker.invalid/var.png' 1x;background-image:image-set(var(--candidate));margin:2px">var</div>
      <div style="display:block;background-image:-webkit-image-set('https://tracker.invalid/legacy.png' 1x)">legacy</div>`;
    const out = blockRemoteImages(html);

    expect(out).not.toContain('tracker.invalid/plain.png');
    expect(out).not.toContain('tracker.invalid/entity.png');
    expect(out).not.toContain('tracker.invalid/legacy.png');
    expect(out).not.toContain('image-set(var(');
    expect(out).toContain('color:red');
    expect(out).toContain('padding:4px');
    expect(out).toContain('margin:2px');
    expect(out).toContain('display:block');
  });

  it('matches the guarded route composition for legacy inline image-set rows', () => {
    const legacy = `<div style="color:red;background-image:image-set(&quot;https://tracker.invalid/entity.png&quot; 1x)">entity</div>
      <div style="--candidate:'https://tracker.invalid/var.png' 1x;background-image:image-set(var(--candidate));padding:4px">var</div>`;
    const response = hasRemoteImages(legacy) ? blockRemoteImages(legacy) : legacy;

    expect(response).not.toContain('tracker.invalid/entity.png');
    expect(response).not.toContain('image-set(var(');
    expect(response).toContain('color:red');
    expect(response).toContain('padding:4px');
  });

  it('blocks every legacy protocol-relative image channel after route detection', () => {
    const legacy = `<img src="//tracker.invalid/src.png"><img src="data:," srcset="//tracker.invalid/srcset.png 1x">
      <table background="//tracker.invalid/background.png"></table>
      <div style="color:red;background:url(//tracker.invalid/inline.png)">x</div>
      <style>.x{background:url(//tracker.invalid/block.png)}@import "//tracker.invalid/theme.css";</style>`;
    const response = hasRemoteImages(legacy) ? blockRemoteImages(legacy) : legacy;

    expect(response).not.toContain('//tracker.invalid');
    expect(response).not.toContain('srcset=');
    expect(response).toContain('color:red');
  });

  it('blocks every legacy root-relative app-origin image channel', () => {
    const legacy = `<img src="/api/probe?src"><img src="data:," srcset="/api/probe?srcset 1x">
      <table background="/api/probe?background"></table>
      <div style="color:red;background:url(/api/probe?inline)">x</div>
      <style>.x{background:url(/api/probe?block)}@import "/api/probe?import";</style>`;
    const response = hasRemoteImages(legacy) ? blockRemoteImages(legacy) : legacy;

    expect(response).not.toContain('/api/probe');
    expect(response).not.toContain('srcset=');
    expect(response).toContain('color:red');
  });

  it('blocks URL-parser-compatible legacy image source spellings', () => {
    const sources = [
      '\\\\tracker.invalid\\a.png',
      '\\/tracker.invalid/a.png',
      '/\\tracker.invalid/a.png',
      ' \thttps://tracker.invalid/space.png',
      'http:\\\\tracker.invalid/http.png',
      'https:\\\\tracker.invalid/https.png',
      'http:tracker.invalid/no-slashes.png',
      'h\tt\nt\rps://tracker.invalid/controls.png',
      '/api/probe',
    ];
    const legacy = sources.map(source => `<img src="${source}">`).join('');
    const response = hasRemoteImages(legacy) ? blockRemoteImages(legacy) : legacy;

    expect(response).not.toContain('tracker.invalid');
    expect(response).not.toContain('/api/probe');
    expect(response.match(/src="data:image\/svg\+xml,/g)).toHaveLength(sources.length);
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
