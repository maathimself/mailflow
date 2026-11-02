import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { listUserIdentities, removeIdentitiesForPasswordReset, unlinkUserIdentity } from './userIdentities.js';

// #714: a password reset leaves no single sign-on identity behind while password sign-in is on,
// and removing one never leaves the user without a way to sign in. Uses only connection-local
// temporary tables in an explicitly supplied database.
describe.skipIf(!process.env.MAILFLOW_TEST_DATABASE_URL)('linked identities', () => {
  let db;
  const U1 = '11111111-1111-4111-8111-111111111111';
  const U2 = '22222222-2222-4222-8222-222222222222';
  const P = '33333333-3333-4333-8333-333333333333';
  const passwordSignIn = on => db.query("UPDATE system_settings SET value = $1 WHERE key = 'internal_auth_disabled'", [on ? 'false' : 'true']);
  const link = async (user, subject) => (await db.query(
    "INSERT INTO user_identities (user_id, provider_id, issuer, subject, email) VALUES ($1, $2, 'https://idp', $3, $3 || '@idp') RETURNING id",
    [user, P, subject])).rows[0].id;
  const subjects = async user => (await db.query('SELECT subject FROM user_identities WHERE user_id = $1 ORDER BY subject', [user])).rows.map(r => r.subject);

  beforeAll(async () => {
    db = new pg.Client({ connectionString: process.env.MAILFLOW_TEST_DATABASE_URL });
    await db.connect();
    await db.query(`
      CREATE TEMP TABLE users (id uuid PRIMARY KEY, password_hash text);
      CREATE TEMP TABLE oidc_providers (id uuid PRIMARY KEY, name text, slug text);
      CREATE TEMP TABLE system_settings (key text PRIMARY KEY, value text);
      CREATE TEMP TABLE user_identities (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, provider_id uuid,
        issuer text, subject text, email text, created_at timestamptz DEFAULT now(), last_used_at timestamptz)`);
  });
  afterAll(async () => { await db?.end(); });
  beforeEach(async () => {
    await db.query('TRUNCATE users, oidc_providers, system_settings, user_identities');
    await db.query("INSERT INTO oidc_providers VALUES ($1, 'Pocket ID', 'pocket')", [P]);
    await db.query("INSERT INTO system_settings VALUES ('internal_auth_disabled', 'false')");
    await db.query("INSERT INTO users VALUES ($1, 'hash'), ($2, NULL)", [U1, U2]);
  });

  it('a password reset removes the user\'s identities while password sign-in is on', async () => {
    await link(U1, 'a'); await link(U1, 'b'); await link(U2, 'c');
    const removed = await removeIdentitiesForPasswordReset(db, U1);
    expect(removed.map(r => r.provider_name)).toEqual(['Pocket ID', 'Pocket ID']);
    expect(await subjects(U1)).toEqual([]);
    expect(await subjects(U2)).toEqual(['c']);
  });

  it('and keeps them while password sign-in is off, as the new password cannot sign in', async () => {
    await link(U1, 'a');
    await passwordSignIn(false);
    expect(await removeIdentitiesForPasswordReset(db, U1)).toEqual([]);
    expect(await subjects(U1)).toEqual(['a']);
  });

  it('unlinks an identity the user can do without', async () => {
    const a = await link(U1, 'a'); await link(U1, 'b');
    expect((await unlinkUserIdentity(db, U1, a)).identity.provider_name).toBe('Pocket ID');
    expect(await subjects(U1)).toEqual(['b']);
    // The last one too, as the user has a password and password sign-in is on.
    const [{ id: b }] = await listUserIdentities(db, U1);
    expect((await unlinkUserIdentity(db, U1, b)).identity).toBeTruthy();
    expect(await subjects(U1)).toEqual([]);
  });

  it('keeps the last identity of a user with no other way to sign in', async () => {
    const c = await link(U2, 'c');
    expect(await unlinkUserIdentity(db, U2, c)).toEqual({ lastSignIn: true });
    const a = await link(U1, 'a');
    await passwordSignIn(false);
    expect(await unlinkUserIdentity(db, U1, a)).toEqual({ lastSignIn: true });
    expect(await subjects(U1)).toEqual(['a']);
    expect(await subjects(U2)).toEqual(['c']);
  });

  it('finds no identity of another user', async () => {
    await link(U1, 'a');
    const c = await link(U2, 'c'); await link(U2, 'd');
    expect(await unlinkUserIdentity(db, U1, c)).toEqual({ notFound: true });
    expect(await subjects(U2)).toEqual(['c', 'd']);
  });
});
