import { describe, it, expect } from 'vitest';
import {
  stripEmailHead,
  sanitizeEmail,
  sanitizeSignature,
  hasRemoteImages,
  blockRemoteImages,
  rewriteEbayImageserUrls,
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

  it('upgrades http:// url() in <style> blocks', () => {
    const out = sanitizeEmail('<style>body{background:url(http://example.com/bg.jpg)}</style>');
    expect(out).not.toContain('url(http://');
    expect(out).toContain('url(https://');
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
  it('replaces remote img src with data:,', () => {
    const out = blockRemoteImages('<img src="https://example.com/tracker.png">');
    expect(out).toContain('src="data:,"');
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
