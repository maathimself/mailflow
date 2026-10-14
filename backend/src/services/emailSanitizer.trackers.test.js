// Open-tracking images and the image proxy: what counts as a tracker, what becomes of one, and
// that the proxy never fetches one.
import { describe, expect, it } from 'vitest';
import { isTrackingUrl, proxyRemoteImages, remoteImageRefs, TRACKER_REPLACEMENT } from './emailSanitizer.js';

const toProxy = (raw) => `/proxy?u=${encodeURIComponent(raw)}`;

describe('isTrackingUrl', () => {
  it.each([
    'https://u37524587.ct.sendgrid.net/wf/open?upn=u001.Us-2By-2F9n6jt5mCYP7Zw3Z',
    'https://example.us1.list-manage.com/track/open.php?u=abc&id=def&e=ghi',
    'https://cl.s7.exct.net/open.aspx?ffcb10-fec0157',
    'https://starlink.com/api/notifications/v1/open/DF8D8553B0A567BDE3C5',
    'https://mail.example.com/e/opened/abc',
    'https://track.example.com/pixel.gif?id=1',
    'https://news.example.com/beacon.png',
    'https://email.example.com/o/eJwtjEEOgjAQRe_SNQtaKC0rL2IIGWBATEunNBQBBLlZv',
    'https://track.customer.io/e/o/eyJlbWFpbF9pZCI6IkRlaFRBd0FBQVlx',
    'https://abc.r.us-east-1.awstrack.me/I0/0100018f3b2a1c4d-6b9d8e7f-1234',
    'https://click.redditmail.com/CI0/010001a13672dde1-525efc1a-afc7-4069',
  ])('recognizes %s', (url) => {
    expect(isTrackingUrl(url)).toBe(true);
  });

  it.each([
    'https://www.google.com/images/branding/googlelogo/1x/googlelogo_color_272x92dp.png',
    'https://cdn.example.com/open/images/logo.png',
    'https://cdn.example.com/opendata/chart.png',
    'https://cdn.example.com/assets/open-house.jpg',
    'https://cdn.example.com/o/logo.png',
    'https://cdn.example.com/e/o/short',
    'https://starlink.com/public-files/Starlink_V4_Canada_Aurora.webp',
    'https://storage.googleapis.com/contentgrid-active/images/HD_Youtube_Icon.png',
    'not a url',
  ])('leaves %s alone', (url) => {
    expect(isTrackingUrl(url)).toBe(false);
  });
});

describe('proxyRemoteImages and trackers', () => {
  it('replaces an image the email sizes at 1x1, keeping its attributes, and counts it', () => {
    const html = '<p>Hi</p><img src="https://img.example/p.gif" width="1" height="1" alt=""><img src="https://img.example/logo.png" width="200" height="50">';
    const stats = {};
    const out = proxyRemoteImages(html, toProxy, stats);
    expect(out).toContain(`<img src="${TRACKER_REPLACEMENT}" width="1" height="1" alt="">`);
    expect(out).toContain(`<img src="${toProxy('https://img.example/logo.png')}" width="200" height="50">`);
    expect(stats.trackers).toBe(1);
  });

  it('reads the size from an inline style too, in px', () => {
    const stats = {};
    const out = proxyRemoteImages('<img style="width:1px; height: 0px; border:0" src="https://img.example/a.gif">', toProxy, stats);
    expect(out).toContain(TRACKER_REPLACEMENT);
    expect(stats.trackers).toBe(1);
  });

  it('needs both sizes: an image with only a tiny width, or a max-width, still loads', () => {
    const stats = {};
    const html = '<img src="https://img.example/a.png" width="1"><img src="https://img.example/b.png" style="max-width:1px;max-height:1px">';
    const out = proxyRemoteImages(html, toProxy, stats);
    expect(out).not.toContain(TRACKER_REPLACEMENT);
    expect(stats.trackers).toBe(0);
  });

  it('loads an image hidden with display:none (a dark-mode logo)', () => {
    const out = proxyRemoteImages('<img src="https://img.example/dark-logo.png" style="display:none" width="150" height="40">', toProxy);
    expect(out).toContain(toProxy('https://img.example/dark-logo.png'));
  });

  it('blocks a tracking address wherever it is used, and counts it once', () => {
    const url = 'https://u1.ct.sendgrid.net/wf/open?upn=abc';
    const html = `<img src="${url}"><div style="background-image:url('${url}')">x</div><img src="${url}">`;
    const stats = {};
    const out = proxyRemoteImages(html, toProxy, stats);
    expect(out).not.toContain('sendgrid');
    expect(stats.trackers).toBe(1);
  });

  it('leaves the proxy list without trackers, so the proxy route never fetches one', () => {
    const html = '<img src="https://img.example/p.gif" width="1" height="1"><img src="https://u1.ct.sendgrid.net/wf/open?upn=abc"><img src="https://img.example/logo.png">';
    expect([...remoteImageRefs(html).keys()]).toEqual(['https://img.example/logo.png']);
  });

  it('stays linear on hostile tags', () => {
    const spaces = ' '.repeat(200_000);
    const hostile = [
      `<img src="https://img.example/a.png" width=${spaces}x height=${spaces}x>`,
      `<img src="https://img.example/a.png" width="${spaces}x" style="width:${spaces}x">`,
      '<img width="1" height="1" src="https://img.example/p.gif">'.repeat(20_000),
      `<img src="https://img.example/a.png" width=${'1'.repeat(100_000)}x>`,
    ];
    for (const html of hostile) {
      const started = performance.now();
      proxyRemoteImages(html, toProxy);
      remoteImageRefs(html);
      expect(performance.now() - started).toBeLessThan(1500);
    }
  });
});
