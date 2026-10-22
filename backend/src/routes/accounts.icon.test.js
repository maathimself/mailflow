// A mailbox's icon (#376): exactly one emoji, or none.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../index.js', () => ({ imapManager: {} }));

const { normalizeAccountIcon } = await import('./accounts.js');

describe('normalizeAccountIcon', () => {
  it.each(['🏠', '💼', '🇳🇱', '#️⃣', '👨‍👩‍👧', '👍🏽', '❤️', ' 🛒 ', '🏳️‍🌈', '🏴󠁧󠁢󠁳󠁣󠁴󠁿', '👩🏽‍💻', '1️⃣', '©️'])('takes %s', (icon) => {
    expect(normalizeAccountIcon(icon)).toEqual({ value: icon.trim() });
  });
  it.each([null, undefined, '', '   '])('takes %s as none', (icon) => {
    expect(normalizeAccountIcon(icon)).toEqual({ value: null });
  });
  it.each(['A', 'ab', '🏠🏠', '<b>', '1', 'home',
    // One grapheme, but not one emoji: combining marks piled on one, a letter keycap, an invisible
    // tag character, a lone regional indicator, and text symbols without the emoji form.
    `😀${'\u0301'.repeat(25)}`, 'a\u20E3', '\u{E0061}', '\u{1F1F3}', '©', '™'])('refuses %s', (icon) => {
    expect(normalizeAccountIcon(icon).error).toBe('icon must be a single emoji');
  });
  it('refuses what is not a string', () => {
    expect(normalizeAccountIcon(5).error).toBe('icon must be a string');
  });
});
