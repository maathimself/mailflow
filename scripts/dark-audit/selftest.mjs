// Dark-mode audit (#228): checks the harness, and the reader's dark-body code it drives, on made-up
// emails whose right answers are known. Needs Playwright's Chromium.
//
//   node scripts/dark-audit/selftest.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync, crc32 } from 'node:zlib';
import { prepareCorpus } from './prepare.mjs';
import { auditEmails, totals } from './audit.mjs';

const CARD = 'padding:40px;height:400px';

// A PNG of `width` x `height`, each pixel from `pixel(x, y)` as [r, g, b, a].
function png(width, height, pixel) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) raw.set(pixel(x, y), y * (width * 4 + 1) + 1 + x * 4);
  }
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
// A remote logo as the image proxy serves it: black lettering on a transparent background.
const DARK_LOGO = png(160, 50, (x, y) => (x >= 10 && x < 150 && y >= 10 && y < 40 ? [17, 17, 17, 255] : [0, 0, 0, 0]));
const PROXY_URL = '/api/mail/messages/4d479e4f-9b21-4013-9c07-3fbc35f275b1/image?u=https%3A%2F%2Flogo.example%2Flogo.png';
const svg = (body, w = 160, h = 50) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${body}</svg>`)}`;
export const FIXTURES = {
  // Sets no colors: the theme's text on the theme's background reads fine.
  plain: '<p>Hello there, this is a plain email with no colors of its own.</p>',
  // Dark text set by the sender stays dark on the dark background unless recolored.
  inlineDarkText: '<p style="color:#333333">Dark gray text set inline by the sender, a whole sentence of it.</p>',
  // A white card keeps its own dark text: readable, but a bright block, unless recolored.
  whiteCard: `<table width="100%" bgcolor="#ffffff" cellpadding="0" cellspacing="0"><tr><td style="color:#222222;${CARD}">Card text in a white table cell, as most newsletters are built.</td></tr></table>`,
  // Preview text hidden in the usual ways is not text anyone reads.
  preheader: '<div style="display:none">Hidden one</div>'
    + '<span style="font-size:1px;color:#ffffff;line-height:1px">Hidden two</span>'
    + '<div style="max-height:0;overflow:hidden">Hidden three</div>'
    + '<div style="color:#ffffff">Hidden four, white on white</div>'
    + '<div style="position:absolute;left:-9999px">Hidden five</div>'
    + '<p>Visible body text.</p>',
  // Text over a background image has no single background color: left as sent.
  backgroundImage: '<table><tr><td style="background-image:url(https://example.invalid/bg.png);background-color:#123456;color:#ffffff;padding:20px">Text over an image</td></tr></table>',
  // A light area under a background image (a hero banner) stays as sent, light, as its colors
  // cannot be read; the email around it is still shown dark.
  lightImageArea: `<div style="background-image:url(https://example.invalid/hero.png);background-color:#ffffff;color:#222222;${CARD}">Headline over a light hero image</div><p>Text below the hero.</p>`,
  // The sender's own dark design, which is preferred when it reads.
  senderDark: '<style>@media (prefers-color-scheme: dark) { .card { background: #111111 !important; color: #eeeeee !important; } }</style>'
    + `<div class="card" style="background:#ffffff;color:#222222;${CARD}">A card that knows how to be dark.</div>`,
  // A sender dark design that darkens the card but misses a line whose inline color wins: MailFlow
  // must not show it, and recolors instead.
  brokenSenderDark: '<style>@media (prefers-color-scheme: dark) { .card { background: #111111 !important; } }</style>'
    + `<div class="card" style="background:#ffffff;${CARD}"><p style="color:#222222 !important">This line keeps its dark inline color in the sender design.</p></div>`,
  // A sender dark design that darkens its card and leaves the gray frame around it as sent
  // (Travelers): readable, but half the email stays light, so MailFlow recolors instead.
  halfDarkSender: '<style>@media (prefers-color-scheme: dark) { .card { background: #272a2d !important; color: #ffffff !important; } }</style>'
    + '<table width="100%" bgcolor="#dadadb" cellpadding="0" cellspacing="0"><tr><td style="padding:60px 140px">'
    + `<div class="card" style="background:#ffffff;color:#222222;${CARD}">A card the sender darkens inside a gray frame it leaves light.</div>`
    + '</td></tr></table>',
  // Colored text and a pale colored callout keep their hues.
  colors: '<p style="color:#d32f2f">Red warning text that should stay red.</p>'
    + '<p style="color:#1565c0">Blue informational text that should stay blue.</p>'
    + '<div style="background:#fff3cd;color:#856404;padding:12px">A pale yellow callout with brown text.</div>',
  // A dark header with white text is dark already: left alone.
  darkHeader: '<div id="hdr" style="background:#1a237e;color:#ffffff;padding:16px">Dark header with white text</div><p>Body text below it.</p>',
  // Links that animate their color, common in newsletters: showing it dark must not read the
  // color mid-animation and take the old dark text on the new dark background as unreadable.
  transitions: '<style>a, p { transition: color 2s, background-color 2s; }</style>'
    + '<p style="color:#222222">Body text that fades between colors.</p><p><a href="https://example.invalid/" style="color:#1a0dab">A link that fades too</a></p>',
  // Transitions the email declares more forcefully than MailFlow's switch-off rule can override:
  // !important with a more specific selector, and inline !important (seen in real mail).
  forcedTransitions: '<style>td p a.lnk { transition: all 0.5s !important; }</style>'
    + '<table width="100%"><tr><td bgcolor="#ffffff"><p style="color:#232323"><a class="lnk" href="https://example.invalid/" style="color:#3700ff">A link that insists on fading</a></p>'
    + '<p><a href="https://example.invalid/" style="color:#3700ff;transition:color 0.5s !important">Another one, inline</a></p></td></tr></table>',
  // Inline images (cid: images arrive as data: URIs, which MailFlow can read): a dark logo on a
  // transparent background would vanish and gets a light backing; a white logo and an opaque
  // image do not.
  images: `<p>Logos:</p><img id="dark-logo" width="160" height="50" src="${svg('<rect x="10" y="10" width="140" height="30" fill="#111111"/>')}">`
    + `<img id="light-logo" width="160" height="50" src="${svg('<rect x="10" y="10" width="140" height="30" fill="#ffffff"/>')}">`
    + `<img id="photo" width="160" height="50" src="${svg('<rect width="160" height="50" fill="#202020"/>')}">`,
  // Remote images as MailFlow serves them blocked (its default): the image becomes a light gray
  // placeholder, drawn dark with the body; a blocked background image no longer counts as an
  // image, so the area behind it is recolored instead of left light.
  blockedImages: {
    blockImages: true,
    html: '<img width="300" height="80" src="https://example.invalid/banner.png">'
      + `<div style="background-image:url(https://example.invalid/hero.png);background-color:#ffffff;color:#222222;${CARD}">Headline over a blocked hero image</div>`,
  },
  // Text whose fill color (-webkit-text-fill-color, which wins over color) an ancestor set to the
  // same gray as its color: recoloring the color alone left the text drawn in the old gray (seen in
  // real mail).
  inheritedFill: `<table width="100%" bgcolor="#ffffff"><tr><td style="color:#3e3e3e;-webkit-text-fill-color:#3e3e3e;padding:20px"><div style="color:#3e3e3e">Text drawn with a fill color its cell set.</div></td></tr></table>`,
  // A remote logo loaded through MailFlow's image proxy, in a frame whose CSP allows images from
  // MailFlow alone, as the reader's is: it must load in every engine (Firefox refused 'self' in a
  // srcdoc frame), and the page can read its pixels, so a dark one on a transparent background gets
  // its backing like an inline image.
  proxiedLogo: { proxied: true, html: `<p>Logo:</p><img width="160" height="50" src="${PROXY_URL}">` },
  // A sender that asks to stay light.
  lightOnly: '<html><head><meta name="color-scheme" content="only light"></head><body><p style="color:#333">Keep me light please.</p><img src="https://example.invalid/pixel.gif" width="1" height="1"></body></html>',
};

export async function runSelftest() {
  const dir = mkdtempSync(join(tmpdir(), 'dark-audit-selftest-'));
  try {
    writeFileSync(join(dir, 'synthetic.jsonl'), Object.entries(FIXTURES)
      .map(([key, f]) => JSON.stringify({ key, instance: 'selftest', domain: `${key}.example`, subject: key, ...(typeof f === 'string' ? { html: f } : f) }))
      .join('\n') + '\n');
    const prepared = prepareCorpus(dir);
    const byKey = Object.fromEntries(prepared.map(e => [e.key, e]));
    assert.ok(byKey.senderDark.darkCss.includes('#111111'), 'the sender dark design is split off');
    assert.equal(byKey.plain.darkCss, '');
    assert.equal(byKey.lightOnly.lightOnly, true);

    const stats = {};
    const list = await auditEmails(prepared, { stats, proxyImage: (u) => (u === 'https://logo.example/logo.png' ? DARK_LOGO : null) });
    const results = Object.fromEntries(list.map(r => [r.key, r]));
    for (const r of list) {
      assert.equal(r.error, undefined, `${r.key}: ${r.error}`);
      assert.equal(r.restoreMismatch, false, `${r.key}: putting it back as sent is exact`);
    }
    assert.ok(stats.blocked > 0, 'the fixtures do make requests');
    assert.equal(stats.served + stats.proxied + stats.blocked, stats.requests, 'every request is the harness, the stand-in image proxy, or blocked');
    assert.deepEqual([...stats.servedPaths].sort(), [
      '/frontend/src/utils/darkBody.js', '/frontend/src/utils/darkImages.js', '/frontend/src/utils/darkRecolor.js',
      '/frontend/src/utils/emailContrast.js', '/frontend/src/utils/emailFrameDoc.js', '/frontend/src/utils/emailFrameHeight.js',
      '/frontend/src/utils/oklch.js', '/frontend/src/utils/remoteImagePolicy.js', '/scripts/dark-audit/harness.html',
    ], 'only the harness page and the reader modules it imports are served');

    const m = (key, mode) => results[key].modes[mode];
    const auto = (key) => m(key, 'auto');

    assert.equal(m('plain', 'naive').verdict, 'clean');
    assert.equal(auto('plain').outcome, 'recolor');
    assert.ok(auto('plain').bright < 0.05, `plain recolored is dark: ${auto('plain').bright}`);

    assert.equal(m('inlineDarkText', 'naive').verdict, 'broken');
    assert.equal(m('inlineDarkText', 'recolor').verdict, 'clean', 'recoloring lightens the dark text');
    assert.equal(auto('inlineDarkText').outcome, 'recolor');

    assert.ok(m('whiteCard', 'naive').bright > 0.5, 'naive leaves the white card bright');
    assert.equal(auto('whiteCard').outcome, 'recolor');
    assert.ok(auto('whiteCard').bright < 0.05, `recolored card is dark: ${auto('whiteCard').bright}`);

    // Only "Visible body text." reads; the white-on-white line is the sender's own hiding.
    assert.equal(m('preheader', 'light').summary.chars, 'Visible body text.'.length + 'Hidden four, white on white'.length);
    assert.equal(auto('preheader').counted, 'Visible body text.'.length);
    assert.equal(auto('preheader').verdict, 'clean');
    assert.equal(auto('preheader').summary.hidden, 'Hidden four, white on white'.length, 'hidden text stays hidden when recolored');

    assert.equal(m('backgroundImage', 'light').summary.overImage, 'Text over an image'.length);
    assert.equal(auto('backgroundImage').summary.overImage, 'Text over an image'.length, 'left as sent');

    assert.equal(auto('lightImageArea').outcome, 'recolor');
    assert.ok(auto('lightImageArea').bright > 0.5, `the hero area stays light: ${auto('lightImageArea').bright}`);
    assert.equal(auto('lightImageArea').summary.overImage, 'Headline over a light hero image'.length);

    assert.equal(auto('senderDark').outcome, 'sender', "the sender's design is preferred");
    assert.ok(auto('senderDark').bright < 0.05);

    assert.equal(m('halfDarkSender', 'sender').verdict, 'clean', 'the half-dark design reads');
    assert.ok(m('halfDarkSender', 'sender').bright > 0.25, `it leaves the frame light: ${m('halfDarkSender', 'sender').bright}`);
    assert.equal(auto('halfDarkSender').outcome, 'recolor', 'a sender design that leaves much light gives way to recoloring');
    assert.ok(auto('halfDarkSender').bright < 0.05, `recolored, the frame is dark too: ${auto('halfDarkSender').bright}`);

    assert.equal(m('brokenSenderDark', 'sender').verdict, 'broken', 'the broken design is caught');
    assert.deepEqual(auto('brokenSenderDark').attempts.map(a => [a.kind, a.verdict]), [['sender', 'broken'], ['recolor', 'clean']]);
    assert.equal(auto('brokenSenderDark').outcome, 'recolor');

    assert.equal(auto('colors').outcome, 'recolor');
    assert.equal(auto('colors').verdict, 'clean');
    assert.ok(auto('colors').bright < 0.05);

    assert.equal(auto('darkHeader').outcome, 'recolor');
    assert.equal(auto('darkHeader').verdict, 'clean');

    assert.equal(auto('transitions').outcome, 'recolor', 'not refused because of a running transition');
    assert.equal(auto('transitions').verdict, 'clean');

    assert.equal(auto('forcedTransitions').outcome, 'recolor', 'not refused because of a transition MailFlow could not switch off');
    assert.equal(m('forcedTransitions', 'recolor').verdict, 'clean');

    assert.equal(stats.proxied >= 1, true, 'the proxied logo was asked for through the proxy');
    assert.deepEqual(auto('proxiedLogo').images, { placeholders: 0, backed: 1, waiting: 0 }, 'a proxied dark logo is backed');

    assert.equal(auto('images').outcome, 'recolor');
    assert.deepEqual(auto('images').images, { placeholders: 0, backed: 1, waiting: 0 }, 'only the dark logo is backed');
    assert.equal(byKey.blockedImages.imagesBlocked, true);
    assert.match(byKey.blockedImages.html, /data:image\/svg\+xml,/, 'the remote image became a placeholder');
    assert.equal(auto('blockedImages').outcome, 'recolor');
    assert.equal(auto('blockedImages').images.placeholders, 1, 'the placeholder is drawn dark');
    assert.equal(auto('blockedImages').summary.overImage, 0, 'a blocked background image is no image');
    assert.ok(auto('blockedImages').bright < 0.05, `blocked hero area and placeholder are dark: ${auto('blockedImages').bright}`);
    assert.ok(m('blockedImages', 'light').bright > 0.5);

    assert.equal(m('inheritedFill', 'recolor').verdict, 'clean', 'the fill follows the recolored text');
    assert.equal(auto('inheritedFill').outcome, 'recolor');

    assert.deepEqual(Object.keys(results.lightOnly.modes), ['light'], 'a sender that asks to stay light is never shown dark');

    const t = totals(list);
    assert.equal(t.restoreMismatches, 0);
    assert.equal(t.auto.broken, 0, 'what the reader shows never has broken text');
    return { fixtures: Object.keys(FIXTURES).length, stats, totals: t };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const { fixtures, stats } = await runSelftest();
console.log(`selftest passed: ${fixtures} fixtures, ${stats.blocked} network requests blocked, ${stats.served} harness files served`);
