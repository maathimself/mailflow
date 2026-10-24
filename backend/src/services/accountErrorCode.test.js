import { afterEach, describe, expect, it } from 'vitest';
import {
  ACCOUNT_ERROR_CODES, classifyAccountError, classifyRefreshFailure, clearRefreshFailure,
  isPersonalMicrosoftAccount, noteRefreshFailure, refreshFailureFor, terminalRefreshError,
} from './accountErrorCode.js';

const outlook = { id: 'a1', email_address: 'maria.lopez@outlook.com', oauth_provider: 'microsoft', oauth_tenant_id: 'consumers' };
const work = { id: 'a2', email_address: 'maria@contoso.example', oauth_provider: 'microsoft', oauth_tenant_id: 'organizations' };
const gmail = { id: 'a3', email_address: 'maria@gmail.com', oauth_provider: 'google' };
const password = { id: 'a4', email_address: 'maria@example.com', oauth_provider: null };

afterEach(() => { for (const a of [outlook, work, gmail, password]) clearRefreshFailure(a.id); });

describe('classifyAccountError', () => {
  it('tells a personal Outlook.com mailbox with IMAP off from a work one', () => {
    const text = 'User is authenticated but not connected.';
    expect(classifyAccountError(outlook, text)).toEqual({ code: 'ms_imap_disabled_personal', detail: text });
    expect(classifyAccountError(work, text)).toEqual({ code: 'ms_imap_disabled_work', detail: text });
  });

  it('asks an OAuth account to sign in again when the server rejects its token', () => {
    // Outlook's answer to a rejected XOAUTH2 token, which isAuthFailure does not match.
    expect(classifyAccountError(outlook, 'AUTHENTICATE failed.').code).toBe('oauth_reauth');
    expect(classifyAccountError(gmail, '[AUTHENTICATIONFAILED] Invalid credentials (Failure)', { authFailure: true }).code).toBe('oauth_reauth');
  });

  it('reports the refresh that caused an auth failure, with its own text', () => {
    noteRefreshFailure(outlook.id, { code: 'oauth_reauth', detail: 'AADSTS700082: The refresh token has expired due to inactivity.' });
    expect(classifyAccountError(outlook, 'AUTHENTICATE failed.')).toEqual({
      code: 'oauth_reauth', detail: 'AADSTS700082: The refresh token has expired due to inactivity.',
    });
    noteRefreshFailure(work.id, { code: 'oauth_app_config', detail: 'AADSTS7000215: Invalid client secret provided.' });
    expect(classifyAccountError(work, 'AUTHENTICATE failed.').code).toBe('oauth_app_config');
  });

  it('leaves a refresh failure out of an unrelated connection failure', () => {
    noteRefreshFailure(outlook.id, { code: 'oauth_reauth', detail: 'AADSTS70008: expired' });
    expect(classifyAccountError(outlook, 'IMAP connect timeout (30000ms)')).toEqual({ code: 'connection', detail: 'IMAP connect timeout (30000ms)' });
  });

  it('marks a rejected password on a password account, and everything else as a connection error', () => {
    expect(classifyAccountError(password, 'Invalid credentials', { authFailure: true }).code).toBe('auth_failed');
    // The IMAP-off sentence on a non-Microsoft account is not Outlook's switch.
    expect(classifyAccountError(password, 'User is authenticated but not connected.').code).toBe('connection');
    expect(classifyAccountError(password, 'getaddrinfo ENOTFOUND imap.example.com').code).toBe('connection');
  });

  it('only ever returns a known code', () => {
    for (const [account, text, opts] of [
      [outlook, 'User is authenticated but not connected.'], [work, 'AUTHENTICATE failed.'],
      [password, 'login failed', { authFailure: true }], [gmail, 'socket hang up'],
    ]) expect(ACCOUNT_ERROR_CODES).toContain(classifyAccountError(account, text, opts).code);
  });
});

describe('isPersonalMicrosoftAccount', () => {
  it.each([
    ['me@outlook.com', 'common', true], ['me@hotmail.co.uk', 'common', true], ['me@live.fr', 'common', true],
    ['me@msn.com', 'common', true], ['me@windowslive.com', 'common', true], ['me@outlook.com.br', 'common', true], ['me@contoso.example', 'consumers', true],
    ['me@contoso.example', 'common', false], ['me@live.example.org', 'organizations', false], ['me@outlookfan.com', 'common', false],
  ])('%s through %s is personal: %s', (email, tenant, expected) => {
    expect(isPersonalMicrosoftAccount({ email_address: email, oauth_tenant_id: tenant })).toBe(expected);
  });
});

describe('classifyRefreshFailure', () => {
  it.each([
    [{ error: 'invalid_grant', error_description: 'AADSTS700082: The refresh token has expired due to inactivity.' }, 'oauth_reauth'],
    [{ error: 'invalid_grant', error_description: 'AADSTS50173: The provided grant has expired due to it being revoked.' }, 'oauth_reauth'],
    [{ error: 'invalid_grant', error_description: 'AADSTS70008: The refresh token has expired due to inactivity.' }, 'oauth_reauth'],
    [{ error: 'interaction_required', error_description: 'AADSTS50076: Due to a configuration change made by your administrator...' }, 'oauth_reauth'],
    [{ error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret provided.' }, 'oauth_app_config'],
    [{ error: 'invalid_client', error_description: "AADSTS7000218: The request body must contain the following parameter: 'client_assertion' or 'client_secret'." }, 'oauth_app_config'],
    [{ error: 'unauthorized_client', error_description: 'AADSTS700016: Application with identifier was not found in the directory.' }, 'oauth_app_config'],
    // Google answers without AADSTS codes.
    [{ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 'oauth_reauth'],
    [{ error: 'invalid_client', error_description: 'The OAuth client was not found.' }, 'oauth_app_config'],
  ])('%o is %s', (tokens, code) => {
    expect(classifyRefreshFailure(tokens)).toBe(code);
  });

  it('leaves a failure that may pass by itself unclassified, so the stored token is still tried', () => {
    expect(classifyRefreshFailure({ error: 'temporarily_unavailable', error_description: 'AADSTS90033: A transient error has occurred.' })).toBeNull();
    expect(classifyRefreshFailure({})).toBeNull();
    // AADSTS90023 is answered when a public client sends a secret; the refresh retries without one.
    expect(classifyRefreshFailure({ error: 'invalid_request', error_description: "AADSTS90023: Public clients can't send a client secret." })).toBeNull();
  });
});

describe('refresh failure memory', () => {
  it('is kept per account until cleared', () => {
    noteRefreshFailure('x', { code: 'oauth_reauth', detail: 'd' });
    expect(refreshFailureFor('x')).toEqual({ code: 'oauth_reauth', detail: 'd' });
    expect(refreshFailureFor('y')).toBeNull();
    clearRefreshFailure('x');
    expect(refreshFailureFor('x')).toBeNull();
  });

  it('terminalRefreshError carries its code', () => {
    const err = terminalRefreshError('expired', 'oauth_reauth');
    expect(err).toBeInstanceOf(Error);
    expect(err).toMatchObject({ message: 'expired', accountErrorCode: 'oauth_reauth' });
  });
});
