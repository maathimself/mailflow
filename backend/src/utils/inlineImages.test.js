import { describe, it, expect } from 'vitest';
import { embedInlineDataImages } from './inlineImages.js';

describe('embedInlineDataImages', () => {
  it('converts data: images to CID inline attachments', () => {
    const html = '<p><img src="data:image/png;base64,QUJD" width="200">test</p>';
    const { html: out, attachments } = embedInlineDataImages(html);

    expect(out).toContain('src="cid:img-');
    expect(out).not.toContain('data:image/png');
    expect(out).toContain('test');
    expect(attachments).toHaveLength(1);
    expect(attachments[0].cid).toMatch(/^img-[a-f0-9]+-0@mailflow$/);
    expect(attachments[0].filename).toBe('image-0.png');
    expect(attachments[0].contentDisposition).toBe('inline');
    expect(attachments[0].contentType).toBe('image/png');
    expect(attachments[0].content.equals(Buffer.from('ABC'))).toBe(true);
  });

  it('leaves remote https images unchanged', () => {
    const html = '<img src="https://example.com/a.jpg" alt="photo">';
    const { html: out, attachments } = embedInlineDataImages(html);
    expect(out).toBe(html);
    expect(attachments).toHaveLength(0);
  });

  it('handles multiple inline images with unique CIDs', () => {
    const html = [
      '<img src="data:image/png;base64,AA">',
      '<img src="data:image/jpeg;base64,BB">',
    ].join('');
    const { html: out, attachments } = embedInlineDataImages(html);
    expect(attachments).toHaveLength(2);
    expect(attachments[0].cid).toMatch(/^img-[a-f0-9]+-0@mailflow$/);
    expect(attachments[0].filename).toBe('image-0.png');
    expect(attachments[1].cid).toMatch(/^img-[a-f0-9]+-1@mailflow$/);
    expect(attachments[1].filename).toBe('image-1.jpg');
    expect(attachments[0].cid).not.toBe(attachments[1].cid);
    expect(out.match(/src="cid:/g)).toHaveLength(2);
  });

  it('returns falsy html unchanged', () => {
    expect(embedInlineDataImages(null)).toEqual({ html: null, attachments: [] });
    expect(embedInlineDataImages('')).toEqual({ html: '', attachments: [] });
  });
});
