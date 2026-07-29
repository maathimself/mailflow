import { describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: vi.fn(),
  requireAdmin: vi.fn(),
}));
vi.mock('../services/encryption.js', () => ({
  encrypt: vi.fn(),
  decrypt: vi.fn(),
}));
vi.mock('../services/hostValidation.js', () => ({ validateHost: vi.fn() }));
vi.mock('../services/connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn() }));

import { aiLanguageInstruction } from './ai.js';

describe('aiLanguageInstruction', () => {
  it.each([
    ['en', 'English'],
    ['ru', 'Russian'],
    ['de', 'German'],
    ['es', 'Spanish'],
    ['fr', 'French'],
    ['it', 'Italian'],
    ['zhCN', 'Simplified Chinese'],
  ])('maps %s to %s', (language, name) => {
    expect(aiLanguageInstruction(language)).toBe(
      `Always respond in ${name}, unless the user explicitly asks for another language. For email drafting and rewriting, preserve the original email language when it differs from ${name}.`,
    );
  });

  it.each([undefined, null, '', 'pt', 'constructor', 'toString'])(
    'uses a non-interpolating fallback for unsupported value %s',
    (language) => {
      expect(aiLanguageInstruction(language)).toBe(
        'Always respond in the user interface language, unless the user explicitly asks for another language. For email drafting and rewriting, preserve the original email language when it differs from the user interface language.',
      );
    },
  );
});
