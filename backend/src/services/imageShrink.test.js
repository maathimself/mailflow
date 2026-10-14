// Oversized proxied images scaled down, with the real sharp: what is resized, what passes through
// byte for byte, and that nothing fails the request.
import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { shrinkImage, SHRINK_ABOVE_BYTES, MAX_WIDTH, MAX_INPUT_PIXELS, MAX_SHRINK_ON_LOAD_PIXELS } from './imageShrink.js';

// Random pixels compress badly, so a photo-sized image is well over the threshold.
const noise = (width, height, channels = 3) => sharp(randomBytes(width * height * channels), { raw: { width, height, channels } });

describe('shrinkImage', () => {
  it('scales a large photo to MAX_WIDTH as WebP, much smaller', async () => {
    const bytes = await noise(3000, 2000).jpeg({ quality: 95 }).toBuffer();
    expect(bytes.length).toBeGreaterThan(SHRINK_ABOVE_BYTES);
    const out = await shrinkImage({ bytes, type: 'image/jpeg' });
    expect(out.type).toBe('image/webp');
    expect(out.bytes.length).toBeLessThan(bytes.length / 2);
    const meta = await sharp(out.bytes).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['webp', MAX_WIDTH, Math.round((2000 * MAX_WIDTH) / 3000)]);
  });

  it('applies the EXIF orientation and drops the metadata', async () => {
    const bytes = await noise(3000, 2000).jpeg({ quality: 95 }).withMetadata({ orientation: 6 }).toBuffer();
    const out = await shrinkImage({ bytes, type: 'image/jpeg' });
    const meta = await sharp(out.bytes).metadata();
    expect([meta.width, meta.height]).toEqual([MAX_WIDTH, 2400]); // turned upright, then scaled
    expect(meta.exif).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
  });

  it('passes small images, GIFs and unknown types through as they are', async () => {
    const small = await noise(100, 100).png().toBuffer();
    const image = { bytes: small, type: 'image/png' };
    expect(await shrinkImage(image)).toBe(image);
    const gif = { bytes: Buffer.alloc(SHRINK_ABOVE_BYTES + 1), type: 'image/gif' };
    expect(await shrinkImage(gif)).toBe(gif);
    const icon = { bytes: Buffer.alloc(SHRINK_ABOVE_BYTES + 1), type: 'image/x-icon' };
    expect(await shrinkImage(icon)).toBe(icon);
  });

  it('keeps an animated image whole', async () => {
    const frames = await Promise.all([0, 1].map(() => noise(1200, 900).png().toBuffer()));
    const bytes = await sharp(frames, { join: { animated: true } }).webp({ quality: 100, lossless: true }).toBuffer();
    expect(bytes.length).toBeGreaterThan(SHRINK_ABOVE_BYTES);
    const image = { bytes, type: 'image/webp' };
    expect(await shrinkImage(image)).toBe(image);
  });

  it('keeps an animated PNG whole', async () => {
    const png = await noise(1200, 900).png().toBuffer();
    // An acTL chunk before the image data is what marks an APNG.
    const ihdrEnd = 8 + 25;
    const bytes = Buffer.concat([png.subarray(0, ihdrEnd), Buffer.from('\0\0\0\x08acTL\0\0\0\x02\0\0\0\0\0\0\0\0', 'latin1'), png.subarray(ihdrEnd)]);
    const image = { bytes, type: 'image/png' };
    expect(await shrinkImage(image)).toBe(image);
  });

  it('passes through what sharp cannot read, or does not make smaller', async () => {
    const broken = { bytes: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(SHRINK_ABOVE_BYTES)]), type: 'image/jpeg' };
    expect(await shrinkImage(broken)).toBe(broken);
    const big = { bytes: Buffer.alloc(SHRINK_ABOVE_BYTES + 1), type: 'image/jpeg' };
    const larger = () => ({ metadata: async () => ({ pages: 1 }), rotate() { return this; }, resize() { return this; }, webp() { return this; }, toBuffer: async () => Buffer.alloc(SHRINK_ABOVE_BYTES + 2) });
    expect(await shrinkImage(big, { sharpImpl: larger })).toBe(big);
  });

  it('limits what it decodes: MAX_INPUT_PIXELS, or more for JPEG and WebP, decoded at a fraction', async () => {
    const limits = {};
    for (const type of ['image/png', 'image/avif', 'image/jpeg', 'image/webp']) {
      const spy = (bytes, opts) => { limits[type] = opts.limitInputPixels; throw new Error('stop'); };
      const big = { bytes: Buffer.alloc(SHRINK_ABOVE_BYTES + 1), type };
      expect(await shrinkImage(big, { sharpImpl: spy })).toBe(big);
    }
    expect(limits).toEqual({ 'image/png': MAX_INPUT_PIXELS, 'image/avif': MAX_INPUT_PIXELS,
      'image/jpeg': MAX_SHRINK_ON_LOAD_PIXELS, 'image/webp': MAX_SHRINK_ON_LOAD_PIXELS });
  });

  it('scales a 10,000 px wide JPEG, as senders send them', async () => {
    const bytes = await noise(10200, 4760).jpeg({ quality: 80 }).toBuffer();
    const out = await shrinkImage({ bytes, type: 'image/jpeg' });
    expect(out.type).toBe('image/webp');
    expect((await sharp(out.bytes).metadata()).width).toBe(MAX_WIDTH);
  });
});
