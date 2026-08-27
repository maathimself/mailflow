import { describe, expect, it } from 'vitest';
import { sanitizeEmailBodyAppearancePrefs } from './emailBodyAppearancePrefs.js';

describe('sanitizeEmailBodyAppearancePrefs', () => {
  it.each(['auto', 'original'])('accepts %s', (value) => {
    expect(sanitizeEmailBodyAppearancePrefs({ emailBodyAppearance: value }))
      .toEqual({ emailBodyAppearance: value });
  });

  it.each([undefined, null, '', 'dark', 'AUTO', 1, true, {}, []])(
    'rejects %j',
    (value) => {
      expect(sanitizeEmailBodyAppearancePrefs({ emailBodyAppearance: value }))
        .toEqual({ emailBodyAppearance: null });
    },
  );

  it('ignores unrelated keys', () => {
    expect(sanitizeEmailBodyAppearancePrefs({ emailBodyAppearance: 'auto', theme: 'evil' }))
      .toEqual({ emailBodyAppearance: 'auto' });
  });
});
