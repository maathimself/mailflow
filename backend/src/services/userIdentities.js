// Single sign-on identities linked to a user (#714): what removing them on a password reset, and
// removing one at a time, may take away without locking the user out.

const IDENTITY_COLUMNS = `ui.id, ui.issuer, ui.email, ui.created_at, ui.last_used_at,
  op.name AS provider_name, op.slug AS provider_slug`;

// Whether password sign-in is on, read inside the caller's transaction and held there, so an admin
// turning it off waits for the caller to commit, or the caller sees it off.
async function passwordSignInOn(client) {
  const { rows } = await client.query(
    "SELECT value FROM system_settings WHERE key = 'internal_auth_disabled' FOR SHARE"
  );
  return rows[0]?.value !== 'true';
}

// The identities linked to a user, oldest first.
export async function listUserIdentities(client, userId) {
  const { rows } = await client.query(
    `SELECT ${IDENTITY_COLUMNS}
       FROM user_identities ui
       JOIN oidc_providers op ON op.id = ui.provider_id
      WHERE ui.user_id = $1
      ORDER BY ui.created_at ASC`,
    [userId]
  );
  return rows;
}

// A password reset takes away a linked identity as it does sessions and trusted devices: someone
// who linked their own account at a provider while holding the user's session could otherwise
// keep signing in through it. Only while password sign-in is on, though; with it off the new
// password cannot sign in, and the identities are the user's only way back. Runs in the caller's
// transaction, with the users row locked, and resolves the identities it removed.
export async function removeIdentitiesForPasswordReset(client, userId) {
  if (!(await passwordSignInOn(client))) return [];
  const { rows } = await client.query(
    `DELETE FROM user_identities ui USING oidc_providers op
      WHERE ui.user_id = $1 AND op.id = ui.provider_id
      RETURNING ${IDENTITY_COLUMNS}`,
    [userId]
  );
  return rows;
}

// Removes one identity of a user unless the user could then no longer sign in: with no identity
// left, they need a password and password sign-in turned on. Runs in the caller's transaction.
// Resolves { identity } when removed, { notFound: true }, or { lastSignIn: true }.
export async function unlinkUserIdentity(client, userId, identityId) {
  const { rows: [user] } = await client.query(
    'SELECT password_hash IS NOT NULL AS has_password FROM users WHERE id = $1 FOR UPDATE', [userId]);
  if (!user) return { notFound: true };
  const identities = await listUserIdentities(client, userId);
  const identity = identities.find(i => i.id === identityId);
  if (!identity) return { notFound: true };
  if (identities.length === 1 && !(user.has_password && await passwordSignInOn(client))) return { lastSignIn: true };
  await client.query('DELETE FROM user_identities WHERE id = $1 AND user_id = $2', [identityId, userId]);
  return { identity };
}
