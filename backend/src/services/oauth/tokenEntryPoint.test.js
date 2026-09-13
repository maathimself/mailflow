import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Static guard for the single OAuth entry point: mail transports are built only from a token
// that went through ensureFreshOAuthAccount. Behavioural coverage lives in the transport tests;
// this catches a new route that decrypts a stored (possibly expired) access token on its own.
const SRC = fileURLToPath(new URL('../../', import.meta.url));

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return name.endsWith('.js') && !name.endsWith('.test.js') ? [path] : [];
  });
}

const files = sourceFiles(SRC).map((path) => ({
  rel: relative(SRC, path).split(sep).join('/'),
  text: readFileSync(path, 'utf8'),
}));

describe('OAuth token entry point (static)', () => {
  it('decrypts stored access tokens only in the IMAP and SMTP transport builders', () => {
    const offenders = files
      .filter(({ text }) => /decrypt\(\s*[\w.]*oauth_access_token\s*\)/.test(text))
      .map(({ rel }) => rel)
      .sort();
    expect(offenders).toEqual(['services/imapManager.js', 'services/smtpTransport.js']);
  });

  it('refreshes through the token manager in both transport builders', () => {
    for (const rel of ['services/imapManager.js', 'services/smtpTransport.js']) {
      const { text } = files.find(f => f.rel === rel);
      expect(text, rel).toMatch(/import \{[^}]*\bensureFreshOAuthAccount\b[^}]*\} from '\.\/oauth\/tokenManager\.js'/);
    }
  });

  it('keeps provider refresh functions out of everything but the token manager', () => {
    const offenders = files
      .filter(({ rel, text }) => rel !== 'services/oauth/tokenManager.js'
        && /import \{[^}]*\b(refreshMicrosoftToken|refreshGoogleToken)\b[^}]*\}/.test(text))
      .map(({ rel }) => rel)
      .sort();
    // routes/oauth.js keeps a re-export of the moved Microsoft refresh for its own tests.
    expect(offenders).toEqual(['routes/oauth.js']);
  });
});
