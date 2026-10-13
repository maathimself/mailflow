import { describe, it, expect } from 'vitest';
import { parseVCard } from './vcard.js';

// photoData is stored and served back as the contact's photo, so a card that says
// PHOTO:data:text/html must not come out of the parser still saying so.
const payload = Buffer.from('<p>not an image</p>').toString('base64');
const photoOf = (line) => parseVCard(`BEGIN:VCARD\r\nVERSION:4.0\r\nFN:Test\r\n${line}\r\nEND:VCARD\r\n`).photoData;

describe('parseVCard PHOTO', () => {
  it.each([
    ['text/html', `PHOTO:data:text/html;base64,${payload}`],
    ['text/javascript', `PHOTO;VALUE=URI:data:text/javascript;base64,${payload}`],
    ['image/svg+xml', `PHOTO:data:image/svg+xml;base64,${payload}`],
    ['application/xhtml+xml', `PHOTO:data:application/xhtml+xml;base64,${payload}`],
    ['application/octet-stream', `PHOTO:data:application/octet-stream;base64,${payload}`],
  ])('relabels data:%s as image/jpeg', (_type, line) => {
    expect(photoOf(line)).toBe(`data:image/jpeg;base64,${payload}`);
  });

  it('keeps an allowed image type and the payload', () => {
    expect(photoOf(`PHOTO:data:image/png;base64,${payload}`)).toBe(`data:image/png;base64,${payload}`);
  });

  it('matches the declared type case-insensitively', () => {
    expect(photoOf(`PHOTO:data:IMAGE/WEBP;base64,${payload}`)).toBe(`data:image/webp;base64,${payload}`);
  });

  it('maps a vCard 3.0 TYPE through the same list', () => {
    expect(photoOf(`PHOTO;ENCODING=b;TYPE=PNG:${payload}`)).toBe(`data:image/png;base64,${payload}`);
    expect(photoOf(`PHOTO;ENCODING=b;TYPE=HTML:${payload}`)).toBe(`data:image/jpeg;base64,${payload}`);
  });
});
