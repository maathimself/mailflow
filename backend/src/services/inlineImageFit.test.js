// Large inline images fitted as the body is served, once, and nothing else touched.
import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { fitInlineImages, INLINE_FIT_ABOVE_BYTES } from './inlineImageFit.js';
import { createImageCache } from './imageCache.js';

const cache = () => createImageCache({ dir: mkdtempSync(join(tmpdir(), 'mf-inline-')) });
const photo = async () => (await sharp(randomBytes(2400 * 1600 * 3), { raw: { width: 2400, height: 1600, channels: 3 } }).jpeg({ quality: 90 }).toBuffer());

describe('fitInlineImages', () => {
  it('fits a large inline photo, and does it once', async () => {
    const bytes = await photo();
    expect(bytes.length).toBeGreaterThan(INLINE_FIT_ABOVE_BYTES);
    const html = `<p>Hi</p><img src="data:image/jpeg;base64,${bytes.toString('base64')}">`;
    const c = cache();
    let shrinks = 0;
    const counted = async (image) => { shrinks += 1; return (await import('./imageShrink.js')).shrinkImage(image); };
    const out = await fitInlineImages(html, 'user-1', { cache: c, shrink: counted });
    expect(out.count).toBe(1);
    expect(out.html.length).toBeLessThan(html.length / 3);
    const sent = Buffer.from(/base64,([^"]+)/.exec(out.html)[1], 'base64');
    expect((await sharp(sent).metadata()).width).toBe(1280);
    await new Promise(r => setTimeout(r, 50));
    expect((await fitInlineImages(html, 'user-1', { cache: c, shrink: counted })).count).toBe(1);
    expect(shrinks).toBe(1);
  });

  it('leaves small images, other types and other HTML as they are', async () => {
    const small = `<img src="data:image/png;base64,${Buffer.alloc(100).toString('base64')}">`;
    const gif = `<img src="data:image/gif;base64,${randomBytes(300 * 1024).toString('base64')}">`;
    for (const html of ['<p>No images</p>', small, gif]) {
      const out = await fitInlineImages(html + 'x'.repeat(INLINE_FIT_ABOVE_BYTES), 'user-1', { cache: cache() });
      expect(out.count).toBe(0);
    }
  });
});
