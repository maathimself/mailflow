import { describe, it, expect, vi } from 'vitest';

// Anything parse5 throws on some unusual body, not only the caps, falls back to sanitizing the
// body as received: the message still shows instead of failing to load.
vi.mock('parse5', async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, parse: vi.fn(() => { throw new TypeError('Cannot read properties of undefined'); }) };
});

const { logger } = await import('./logger.js');
const { sanitizeEmail } = await import('./emailSanitizer.js');

describe('sanitizeEmail — an unexpected parse5 error', () => {
  it('sanitizes the body as received and says why', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      expect(sanitizeEmail('<p onclick="x()">hello</p><script>alert(1)</script>')).toBe('<p>hello</p>');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Cannot read properties of undefined'));
    } finally {
      warn.mockRestore();
    }
  });
});
