import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SAFE_FIELDS, safeAccount } from './accountFields.js';

describe('safeAccount', () => {
  it('returns only SAFE_FIELDS and sanitizes the signature on read', () => {
    const row = Object.fromEntries(SAFE_FIELDS.map(field => [field, `${field}-value`]));
    row.signature = '<b onclick="alert(1)">Safe</b><script>bad()</script>';
    row.auth_pass = 'secret';
    row.oauth_access_token = 'access';
    row.oauth_refresh_token = 'refresh';
    row.user_id = 'user-1';

    const account = safeAccount(row);

    expect(Object.keys(account)).toEqual(SAFE_FIELDS);
    expect(account.signature).toBe('<b>Safe</b>');
    expect(account).not.toHaveProperty('auth_pass');
    expect(account).not.toHaveProperty('oauth_access_token');
    expect(account).not.toHaveProperty('oauth_refresh_token');
    expect(account).not.toHaveProperty('user_id');
  });

  it('keeps every safe field in parity with the REST GET account column list', () => {
    const accountsRoute = readFileSync(
      fileURLToPath(new URL('../routes/accounts.js', import.meta.url)),
      'utf8'
    );
    const select = accountsRoute.match(
      /router\.get\('\/'[\s\S]*?`SELECT\s+([\s\S]*?)\s+FROM email_accounts/
    );
    expect(select).not.toBeNull();

    const selectedFields = select[1]
      .split(',')
      .map(field => field.trim())
      .filter(Boolean);

    expect(SAFE_FIELDS.every(field => selectedFields.includes(field))).toBe(true);
  });
});
