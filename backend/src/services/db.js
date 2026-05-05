import pg from 'pg';
import { encrypt, isEncrypted } from './encryption.js';

const { Pool } = pg;

export const pool = new Pool({
  host: process.env.DB_HOST || 'postgres',
  port: 5432,
  database: process.env.DB_NAME || 'mailflow',
  user: process.env.DB_USER || 'mailflow',
  password: process.env.DB_PASSWORD,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// Set a per-query statement timeout so a slow or runaway query
// can't hold a connection indefinitely.
pool.on('connect', client => {
  client.query('SET statement_timeout = 30000').catch(err =>
    console.error('Failed to set statement_timeout:', err.message)
  );
});

export async function query(text, params) {
  return pool.query(text, params);
}

// One-time startup migration: encrypt any plaintext credentials still in the DB.
// Safe to run on every startup — already-encrypted values are skipped by isEncrypted().
export async function encryptExistingCredentials() {
  if (!process.env.ENCRYPTION_KEY) {
    console.warn('ENCRYPTION_KEY not set — stored credentials are NOT encrypted. Set ENCRYPTION_KEY in .env to enable at-rest encryption.');
    return;
  }

  const result = await pool.query(`
    SELECT id, auth_pass, oauth_access_token, oauth_refresh_token
    FROM email_accounts
    WHERE (auth_pass IS NOT NULL AND auth_pass NOT LIKE 'enc:v1:%')
       OR (oauth_access_token IS NOT NULL AND oauth_access_token NOT LIKE 'enc:v1:%')
       OR (oauth_refresh_token IS NOT NULL AND oauth_refresh_token NOT LIKE 'enc:v1:%')
  `);

  let count = 0;
  for (const row of result.rows) {
    const updates = {};
    if (row.auth_pass && !isEncrypted(row.auth_pass))
      updates.auth_pass = encrypt(row.auth_pass);
    if (row.oauth_access_token && !isEncrypted(row.oauth_access_token))
      updates.oauth_access_token = encrypt(row.oauth_access_token);
    if (row.oauth_refresh_token && !isEncrypted(row.oauth_refresh_token))
      updates.oauth_refresh_token = encrypt(row.oauth_refresh_token);

    if (Object.keys(updates).length) {
      const keys = Object.keys(updates);
      const sets = keys.map((k, i) => `${k} = $${i + 1}`);
      await pool.query(
        `UPDATE email_accounts SET ${sets.join(', ')} WHERE id = $${keys.length + 1}`,
        [...Object.values(updates), row.id]
      );
      count++;
    }
  }
  if (count > 0) console.log(`Encrypted credentials for ${count} account(s)`);

  // Also encrypt OIDC provider client secrets
  const oidcResult = await pool.query(`
    SELECT id, client_secret FROM oidc_providers
    WHERE client_secret IS NOT NULL AND client_secret NOT LIKE 'enc:v1:%'
  `);

  let oidcCount = 0;
  for (const row of oidcResult.rows) {
    if (row.client_secret && !isEncrypted(row.client_secret)) {
      await pool.query(
        'UPDATE oidc_providers SET client_secret = $1 WHERE id = $2',
        [encrypt(row.client_secret), row.id]
      );
      oidcCount++;
    }
  }
  if (oidcCount > 0) console.log(`Encrypted client secrets for ${oidcCount} OIDC provider(s)`);
}
