import { expect, test } from '@playwright/test';
import {
  blockRemoteImages,
  hasRemoteImages,
  sanitizeEmail,
} from '../../../backend/src/services/emailSanitizer.js';

const rawHtml = `<style>
  .hero { background-image:image-set("https://tracker.invalid/plain.png" 1x, "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E" 2x); }
  @media (prefers-color-scheme: dark) {
    .hero { background-image:-webkit-image-set(/* probe */ "h\\74tps://tracker.invalid/dark.png" 1x, "cid:logo" 2x); }
  }
  .direct { --candidate:"https://tracker.invalid/v.png" 1x; background-image:image-set(var(--candidate)); }
  .fallback { background-image:image-set(var(--missing,"https://tracker.invalid/f.png" 1x)); }
</style><div class="hero">Sanitized image-set body</div><div class="direct"></div><div class="fallback"></div>`;

const rawInlineHtml = `<div class="inline-plain" style="color:red;padding:4px;background-image:image-set('https://tracker.invalid/inline.png' 1x)">Inline plain</div>
  <div class="inline-entity" style="color:blue;background-image:image-set(&quot;https://tracker.invalid/entity.png&quot; 1x)">Inline entity</div>
  <div class="inline-var" style="--candidate:'https://tracker.invalid/var.png' 1x;background-image:image-set(var(--candidate));margin:2px">Inline var</div>
  <div class="inline-webkit" style="display:block;background-image:-webkit-image-set('https://tracker.invalid/webkit.png' 1x)">Inline webkit</div>`;

const rawProtocolRelativeHtml = `<img class="protocol-src" alt="src" src="//tracker.invalid/src.png">
  <img class="protocol-srcset" alt="srcset" src="data:," srcset="//tracker.invalid/srcset.png 1x">
  <table class="protocol-background" background="//tracker.invalid/background.png"><tbody><tr><td>Background</td></tr></tbody></table>
  <div class="protocol-inline" style="color:red;padding:4px;background:url(//tracker.invalid/inline.png)">Inline URL</div>
  <style>.protocol-block{background:url(//tracker.invalid/block.png)}@import "//tracker.invalid/theme.css";</style>
  <div class="protocol-block">Style block</div>
  <img alt="backslash network" src="\\\\tracker.invalid\\a.png">
  <img alt="backslash slash" src="\\/tracker.invalid/a.png">
  <img alt="slash backslash" src="/\\tracker.invalid/a.png">
  <img alt="leading whitespace" src=" \thttps://tracker.invalid/space.png">
  <img alt="backslashed http" src="http:\\\\tracker.invalid/http.png">
  <img alt="backslashed https" src="https:\\\\tracker.invalid/https.png">
  <img alt="scheme without slashes" src="http:tracker.invalid/no-slashes.png">
  <img alt="embedded controls" src="h\tt\nt\rps://tracker.invalid/controls.png">
  <img alt="relative src" src="/api/probe?src">
  <img alt="relative srcset" src="data:," srcset="/api/probe?srcset 1x">
  <table background="/api/probe?background"><tbody><tr><td>Relative background</td></tr></tbody></table>
  <div style="background:url(/api/probe?inline)">Relative inline</div>
  <style>.relative-block{background:url(/api/probe?block)}@import "/api/probe?import";</style>
  <div class="relative-block">Relative block</div>`;

const rawEscapedQuoteHtml = String.raw`<div class="css-escape" style="background-image:url('https://safe.invalid/a\27 );background-image:url(/api/probe?x);x:url(\27 safe')">Escaped quote</div>`;

for (const renderer of ['iframe', 'div']) {
  test(`sanitized image-set output makes no external request in the ${renderer} renderer`, async ({ page }) => {
    const sanitized = sanitizeEmail(rawHtml);
    expect(sanitized).not.toContain('image-set(var(');
    expect(sanitized).not.toContain('tracker.invalid/plain.png');
    expect(sanitized).not.toContain('tracker.invalid/dark.png');
    const trackerRequests = [];
    page.on('request', request => {
      if (request.url().includes('tracker.invalid')) trackerRequests.push(request.url());
    });

    if (renderer === 'iframe') {
      await page.setContent('<iframe title="sanitized email"></iframe>');
      await page.locator('iframe').evaluate((frame, html) => { frame.srcdoc = html; }, sanitized);
      await expect(page.frameLocator('iframe').locator('.hero')).toHaveText('Sanitized image-set body');
    } else {
      await page.setContent(`<div data-fixture-root>${sanitized}</div>`);
      await expect(page.locator('[data-fixture-root] .hero')).toHaveText('Sanitized image-set body');
    }
    await page.waitForTimeout(100);

    expect(trackerRequests).toEqual([]);
  });

  test(`sanitized and route-blocked inline image-set output makes no external request in the ${renderer} renderer`, async ({ page }) => {
    const sanitized = sanitizeEmail(rawInlineHtml);
    const guarded = hasRemoteImages(sanitized) ? blockRemoteImages(sanitized) : sanitized;
    const trackerRequests = [];
    page.on('request', request => {
      if (request.url().includes('tracker.invalid')) trackerRequests.push(request.url());
    });

    if (renderer === 'iframe') {
      await page.setContent('<iframe title="sanitized inline email"></iframe>');
      await page.locator('iframe').evaluate((frame, html) => { frame.srcdoc = html; }, guarded);
      await expect(page.frameLocator('iframe').locator('.inline-plain')).toHaveText('Inline plain');
    } else {
      await page.setContent(`<div data-fixture-root>${guarded}</div>`);
      await expect(page.locator('[data-fixture-root] .inline-plain')).toHaveText('Inline plain');
    }
    await page.waitForTimeout(150);

    expect(guarded).toContain('color:red');
    expect(guarded).toContain('padding:4px');
    expect(guarded).not.toContain('image-set(var(');
    expect(trackerRequests).toEqual([]);
  });

  test(`sanitized and route-blocked protocol-relative resources make no external request in the ${renderer} renderer`, async ({ page }) => {
    const sanitized = sanitizeEmail(rawProtocolRelativeHtml);
    const guarded = hasRemoteImages(sanitized) ? blockRemoteImages(sanitized) : sanitized;
    const trackerRequests = [];
    // Give relative URLs a real application-like origin without depending on
    // the shared Vite server for this otherwise self-contained resource probe.
    await page.route('https://mailflow.invalid/', route => route.fulfill({
      contentType: 'text/html', body: '<!doctype html><title>resource probe</title>',
    }));
    await page.goto('https://mailflow.invalid/');
    page.on('request', request => {
      if (request.url().includes('tracker.invalid') || request.url().includes('/api/probe')) {
        trackerRequests.push(request.url());
      }
    });

    if (renderer === 'iframe') {
      await page.setContent('<iframe title="sanitized protocol-relative email"></iframe>');
      await page.locator('iframe').evaluate((frame, html) => { frame.srcdoc = html; }, guarded);
      await expect(page.frameLocator('iframe').locator('.protocol-inline')).toHaveText('Inline URL');
    } else {
      await page.setContent(`<div data-fixture-root>${guarded}</div>`);
      await expect(page.locator('[data-fixture-root] .protocol-inline')).toHaveText('Inline URL');
    }
    await page.waitForTimeout(150);

    expect(guarded).toContain('color:red');
    expect(guarded).toContain('padding:4px');
    expect(trackerRequests).toEqual([]);
  });

  test(`consent-like sanitized escaped-quote CSS makes no app request in the ${renderer} renderer`, async ({ page }) => {
    const sanitized = sanitizeEmail(rawEscapedQuoteHtml);
    expect(sanitized).toContain('safe.invalid');
    const appRequests = [];
    await page.route('https://mailflow.invalid/', route => route.fulfill({
      contentType: 'text/html', body: '<!doctype html><title>resource probe</title>',
    }));
    await page.goto('https://mailflow.invalid/');
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.origin === 'https://mailflow.invalid' && url.pathname === '/api/probe') {
        appRequests.push(request.url());
      }
    });

    if (renderer === 'iframe') {
      await page.setContent('<iframe title="sanitized escaped-quote email"></iframe>');
      await page.locator('iframe').evaluate((frame, html) => { frame.srcdoc = html; }, sanitized);
      await expect(page.frameLocator('iframe').locator('.css-escape')).toHaveText('Escaped quote');
    } else {
      await page.setContent(`<div data-fixture-root>${sanitized}</div>`);
      await expect(page.locator('[data-fixture-root] .css-escape')).toHaveText('Escaped quote');
    }
    await page.waitForTimeout(150);

    expect(appRequests).toEqual([]);
  });
}

test('other quoted-string image functions are rejected before they can request', async ({ page }) => {
  const requests = [];
  page.on('request', request => {
    if (request.url().includes('tracker.invalid')) requests.push(request.url());
  });
  const evidence = await page.evaluate(() => {
    const candidates = {
      image: 'image("https://tracker.invalid/image.png")',
      crossFade: 'cross-fade("https://tracker.invalid/cross-fade.png", linear-gradient(red, blue), 50%)',
      webkitCrossFade: '-webkit-cross-fade("https://tracker.invalid/webkit-cross-fade.png", linear-gradient(red, blue), 0.5)',
    };
    return Object.fromEntries(Object.entries(candidates).map(([name, value]) => {
      const element = document.createElement('div');
      element.style.backgroundImage = value;
      document.body.appendChild(element);
      return [name, {
        supported: CSS.supports('background-image', value),
        inline: element.style.backgroundImage,
        computed: getComputedStyle(element).backgroundImage,
      }];
    }));
  });
  await page.waitForTimeout(150);
  expect(evidence).toEqual({
    image: { supported: false, inline: '', computed: 'none' },
    crossFade: { supported: false, inline: '', computed: 'none' },
    webkitCrossFade: { supported: false, inline: '', computed: 'none' },
  });
  expect(requests).toEqual([]);
});
