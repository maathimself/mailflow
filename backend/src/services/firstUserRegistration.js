import { query } from './db.js';

// The first account to register becomes admin, whatever the registration settings say: that is how
// a new install gets its admin. Where admins come from single sign-on instead, the first visitor
// would take the install over before anyone signed in, so FIRST_USER_REGISTRATION=false turns it off.
export function firstUserRegistrationAllowed(env = process.env) {
  return !/^(0|false|no|off)$/i.test((env.FIRST_USER_REGISTRATION || '').trim());
}

// Registration then starts closed, as the first registration would have left it. Without this the
// open default that only exists for the first registration would stay, for anyone.
export async function closeRegistrationBeforeFirstUser({ env = process.env, queryFn = query } = {}) {
  if (firstUserRegistrationAllowed(env)) return false;
  const { rowCount } = await queryFn(
    `UPDATE system_settings SET value = 'false', updated_at = NOW()
     WHERE key = 'registration_open' AND value <> 'false' AND NOT EXISTS (SELECT 1 FROM users)`
  );
  return rowCount > 0;
}
