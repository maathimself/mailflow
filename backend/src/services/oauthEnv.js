// The OAuth app settings in process.env, read one way everywhere (#676).
//
// The compose files pass each setting through as ${VAR:-}, so a variable left out of .env
// reaches the backend as an empty string rather than not at all. An empty or blank value
// means not set, exactly as an absent one does.
//
// So does the placeholder .env.example shipped: until #676 it carried an uncommented
// GOOGLE_REDIRECT_URI=https://your-domain/oauth/google/callback, which many .env files still
// have. It never reached a Docker backend before, and passing it through now must not make
// Google look configured with a redirect URI that cannot work. Every placeholder the example
// has shipped for these settings is a URL on the host your-domain; the client IDs and secrets
// were always left empty.
const PLACEHOLDER_HOST = 'your-domain';

function isPlaceholder(value) {
  try {
    return new URL(value.trim()).hostname === PLACEHOLDER_HOST;
  } catch {
    return false;
  }
}

// Whether a value counts as set: the same test for .env and for values saved in Settings.
export function isOAuthSetting(value) {
  return typeof value === 'string' && value.trim() !== '' && !isPlaceholder(value);
}

export function oauthEnv(name) {
  const value = process.env[name];
  return isOAuthSetting(value) ? value : undefined;
}

export function getGoogleConfig() {
  return {
    clientId: oauthEnv('GOOGLE_CLIENT_ID'),
    clientSecret: oauthEnv('GOOGLE_CLIENT_SECRET'),
    redirectUri: oauthEnv('GOOGLE_REDIRECT_URI'),
  };
}
