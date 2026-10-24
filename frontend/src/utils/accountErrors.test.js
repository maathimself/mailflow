import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describeAccountError, needsSignIn, OUTLOOK_WEB_URL, signInResultNotice, trustedWrongAccount } from './accountErrors.js';

const en = JSON.parse(readFileSync(new URL('../locales/en.json', import.meta.url), 'utf8'));
const lookup = (key) => key.split('.').reduce((o, k) => o?.[k], en);

const ms = (code, error = 'x') => ({ id: 'a', oauth_provider: 'microsoft', sync_error: error, sync_error_code: code });

describe('describeAccountError', () => {
  test('no error, nothing to say', () => {
    assert.equal(describeAccountError({ sync_error: null, sync_error_code: null }), null);
    assert.equal(describeAccountError(null), null);
  });

  test('Outlook.com with IMAP off: the steps, Open Outlook.com and Try again', () => {
    const d = describeAccountError(ms('ms_imap_disabled_personal', 'User is authenticated but not connected.'));
    assert.equal(d.kind, 'imapOffPersonal');
    assert.deepEqual(d.actions, ['openOutlook', 'retry']);
    assert.equal(d.stepKeys.length, 3);
    assert.equal(d.labelKey, 'accountErrors.label.turnOnImap');
    assert.equal(d.detail, 'User is authenticated but not connected.');
  });

  test('a work mailbox with IMAP off: only Try again, the fix is their IT admin\'s', () => {
    const d = describeAccountError(ms('ms_imap_disabled_work'));
    assert.equal(d.kind, 'imapOffWork');
    assert.deepEqual(d.actions, ['retry']);
    assert.deepEqual(d.stepKeys, []);
  });

  test('an expired or revoked sign-in asks to sign in again, named for the provider', () => {
    assert.deepEqual(describeAccountError(ms('oauth_reauth')).actions, ['signIn']);
    assert.equal(describeAccountError(ms('oauth_reauth')).titleKey, 'accountErrors.signIn.title');
    const google = describeAccountError({ oauth_provider: 'google', sync_error: 'x', sync_error_code: 'oauth_reauth' });
    assert.equal(google.titleKey, 'accountErrors.signIn.titleGoogle');
    assert.equal(google.labelKey, 'accountErrors.label.signInAgain');
  });

  test('an app problem has a body for admins and one for everyone else', () => {
    const d = describeAccountError(ms('oauth_app_config'));
    assert.deepEqual(d.actions, ['retry', 'admin']);
    assert.equal(d.adminBodyKey, 'accountErrors.appConfig.bodyAdmin');
    assert.equal(d.userBodyKey, 'accountErrors.appConfig.bodyUser');
    assert.equal(d.labelKey, 'accountErrors.label.cantConnect');
  });

  test('a rejected password offers Edit account and Try again', () => {
    assert.deepEqual(describeAccountError({ sync_error: 'Invalid credentials', sync_error_code: 'auth_failed' }).actions, ['edit', 'retry']);
  });

  test('an error with no code, or an unknown one, reads as a connection problem', () => {
    for (const code of [null, undefined, 'something_new']) {
      const d = describeAccountError({ sync_error: 'read ETIMEDOUT', sync_error_code: code });
      assert.equal(d.kind, 'connection');
      assert.deepEqual(d.actions, ['retry']);
    }
  });

  test('a password account is never offered Sign in again', () => {
    const d = describeAccountError({ oauth_provider: null, sync_error: 'x', sync_error_code: 'oauth_reauth' });
    assert.deepEqual(d.actions, ['retry']);
    assert.equal(needsSignIn({ oauth_provider: null, sync_error: 'x', sync_error_code: 'oauth_reauth' }), false);
    assert.equal(needsSignIn(ms('oauth_reauth')), true);
    assert.equal(needsSignIn(ms('ms_imap_disabled_personal')), false);
  });

  test('every key it hands out exists in the English locale', () => {
    const codes = ['ms_imap_disabled_personal', 'ms_imap_disabled_work', 'oauth_reauth', 'oauth_app_config', 'auth_failed', 'connection'];
    for (const provider of ['microsoft', 'google', null]) {
      for (const code of codes) {
        const d = describeAccountError({ oauth_provider: provider, sync_error: 'x', sync_error_code: code });
        for (const key of [d.titleKey, d.bodyKey, d.adminBodyKey, d.userBodyKey, d.outroKey, d.labelKey, ...d.stepKeys].filter(Boolean)) {
          assert.equal(typeof lookup(key), 'string', key);
        }
      }
    }
  });

  test('links to Outlook.com itself, not to an unverified settings path', () => {
    assert.equal(OUTLOOK_WEB_URL, 'https://outlook.live.com/mail/');
  });
});

describe('trustedWrongAccount', () => {
  const params = (o) => o;
  const wrong = { error: 'wrong_account', signedInAs: 'other@hotmail.com', expected: 'me@outlook.com' };

  test('names the addresses only for a repair this tab started', () => {
    assert.deepEqual(trustedWrongAccount(params(wrong), true), { signedInAs: 'other@hotmail.com', expected: 'me@outlook.com' });
    assert.equal(trustedWrongAccount(params(wrong), false), null);
  });

  test('and only when both look like addresses', () => {
    assert.equal(trustedWrongAccount(params({ ...wrong, signedInAs: 'Your account is locked, call 555-0100' }), true), null);
    assert.equal(trustedWrongAccount(params({ ...wrong, expected: '<b>x</b>@y.z' }), true), null);
    assert.equal(trustedWrongAccount(params({ ...wrong, error: 'access_denied' }), true), null);
  });
});

describe('signInResultNotice', () => {
  test('connected, still connecting, and an error with its own title', () => {
    assert.deepEqual(signInResultNotice({ connection: 'connected', email: 'a@outlook.com' }, 'microsoft'), { type: 'info', titleKey: 'msSignIn.connected', values: { email: 'a@outlook.com' } });
    assert.equal(signInResultNotice({ connection: 'connecting', email: 'a@outlook.com' }, 'microsoft').titleKey, 'msSignIn.stillConnecting');
    const failed = signInResultNotice({ connection: 'failed', code: 'ms_imap_disabled_work', error: 'x', email: 'a@contoso.example' }, 'microsoft');
    assert.equal(failed.type, 'error');
    assert.equal(failed.titleKey, 'accountErrors.imapOffWork.title');
    assert.equal(signInResultNotice(null, 'microsoft'), null);
  });
});
