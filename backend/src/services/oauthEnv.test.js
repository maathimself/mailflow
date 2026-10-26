import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./microsoftBuiltinApp.js', () => ({ MAILFLOW_MS_CLIENT_ID: 'builtin-app-id' }));
import { getGoogleConfig, isOAuthSetting, oauthEnv } from './oauthEnv.js';
import { getMsConfig, getMsDeviceClient, msRefreshClient, msWorkAccountsAvailable } from './microsoftOAuthClient.js';

const KEYS = ['MS_CLIENT_ID', 'MS_CLIENT_SECRET', 'MS_TENANT_ID', 'MS_REDIRECT_URI', 'MS_BUILTIN_APP',
  'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI'];
const saved = {};
beforeEach(() => { for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

// The compose files pass each OAuth setting through as ${VAR:-}, so one left out of .env
// arrives as an empty string (#676). It has to mean exactly what an absent one does.
describe('an empty OAuth setting is the same as an unset one', () => {
  const setAll = (value) => { for (const k of KEYS) if (k !== 'MS_BUILTIN_APP') process.env[k] = value; };

  it.each(['', '   '])('%j', (value) => {
    const unset = { ms: getMsConfig(), google: getGoogleConfig(), device: getMsDeviceClient('work'), personal: getMsDeviceClient('personal'), refresh: msRefreshClient({}) };
    setAll(value);
    expect({ ms: getMsConfig(), google: getGoogleConfig(), device: getMsDeviceClient('work'), personal: getMsDeviceClient('personal'), refresh: msRefreshClient({}) }).toEqual(unset);
    expect(getMsConfig()).toEqual({ clientId: undefined, clientSecret: undefined, tenantId: 'common', redirectUri: undefined });
    expect(getGoogleConfig()).toEqual({ clientId: undefined, clientSecret: undefined, redirectUri: undefined });
    expect(msWorkAccountsAvailable()).toBe(false);
  });

  it('an empty tenant falls back to common, as an unset one does', () => {
    process.env.MS_CLIENT_ID = 'own-app-id';
    process.env.MS_TENANT_ID = '';
    expect(getMsConfig().tenantId).toBe('common');
    expect(getMsDeviceClient('personal')).toEqual({ clientId: 'own-app-id', tenantId: 'common', builtin: false });
  });

  it('a stored account refreshes through its own client, without the secret, when the settings are empty', () => {
    setAll('');
    expect(msRefreshClient({ oauth_client_id: 'own-app-id', oauth_tenant_id: 'contoso.example' }))
      .toEqual({ clientId: 'own-app-id', tenantId: 'contoso.example', clientSecret: undefined });
  });

  it('the placeholder redirect URIs .env.example has shipped count as unset', () => {
    process.env.GOOGLE_REDIRECT_URI = 'https://your-domain/oauth/google/callback';
    process.env.MS_REDIRECT_URI = ' https://your-domain/oauth/microsoft/callback';
    expect(getGoogleConfig().redirectUri).toBeUndefined();
    expect(getMsConfig().redirectUri).toBeUndefined();
    expect(isOAuthSetting('https://your-domain.example/oauth/google/callback')).toBe(true);
    expect(isOAuthSetting('https://mail.example/oauth/google/callback')).toBe(true);
  });

  it('passes a set value through unchanged', () => {
    process.env.GOOGLE_CLIENT_ID = 'g-client';
    process.env.MS_TENANT_ID = 'organizations';
    expect(oauthEnv('GOOGLE_CLIENT_ID')).toBe('g-client');
    expect(getMsConfig().tenantId).toBe('organizations');
  });
});
