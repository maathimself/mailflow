import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  GOOGLE_OAUTH_PATH,
  REDACTED_CLIENT_SECRET,
  buildGoogleConnectUrl,
  buildGoogleRedirectUri,
  isGoogleReconnectRequired,
  oauthMessageToSearchParams,
  parseOAuthResult,
  resolveClientSecretForSave,
  secretFieldOnBlur,
  secretFieldOnFocus,
} from './googleOAuth.js';

const params = (query) => new URLSearchParams(query);

describe('buildGoogleConnectUrl', () => {
  it('returns the bare same-origin route without a hint', () => {
    assert.equal(GOOGLE_OAUTH_PATH, '/oauth/google');
    assert.equal(buildGoogleConnectUrl(), '/oauth/google');
    assert.equal(buildGoogleConnectUrl({}), '/oauth/google');
  });

  it('ignores blank and non-string hints', () => {
    assert.equal(buildGoogleConnectUrl({ loginHint: '' }), '/oauth/google');
    assert.equal(buildGoogleConnectUrl({ loginHint: '   ' }), '/oauth/google');
    assert.equal(buildGoogleConnectUrl({ loginHint: null }), '/oauth/google');
    assert.equal(buildGoogleConnectUrl({ loginHint: 42 }), '/oauth/google');
  });

  it('adds an encoded login_hint', () => {
    const url = buildGoogleConnectUrl({ loginHint: 'jane+work@gmail.com' });
    assert.equal(url, '/oauth/google?login_hint=jane%2Bwork%40gmail.com');
    assert.equal(new URL(url, 'https://mail.example').searchParams.get('login_hint'), 'jane+work@gmail.com');
  });

  it('encodes non-ASCII and query metacharacters so they cannot inject parameters', () => {
    const url = buildGoogleConnectUrl({ loginHint: 'jöhn&prompt=none#x@gmail.com' });
    const parsed = new URL(url, 'https://mail.example');
    assert.equal(parsed.pathname, '/oauth/google');
    assert.deepEqual([...parsed.searchParams.keys()], ['login_hint']);
    assert.equal(parsed.searchParams.get('login_hint'), 'jöhn&prompt=none#x@gmail.com');
    assert.equal(parsed.hash, '');
  });

  it('trims surrounding whitespace from the hint', () => {
    assert.equal(buildGoogleConnectUrl({ loginHint: '  a@gmail.com ' }), '/oauth/google?login_hint=a%40gmail.com');
  });
});

describe('buildGoogleRedirectUri', () => {
  it('builds the callback from the origin', () => {
    assert.equal(buildGoogleRedirectUri({ origin: 'https://mail.example' }), 'https://mail.example/oauth/google/callback');
    assert.equal(buildGoogleRedirectUri({ origin: 'http://localhost:8080' }), 'http://localhost:8080/oauth/google/callback');
  });

  it('strips a trailing slash from the origin', () => {
    assert.equal(buildGoogleRedirectUri({ origin: 'https://mail.example/' }), 'https://mail.example/oauth/google/callback');
  });
});

describe('isGoogleReconnectRequired', () => {
  it('is true only for Google accounts flagged by the backend', () => {
    assert.equal(isGoogleReconnectRequired({ oauth_provider: 'google', oauth_reconnect_required: true }), true);
    assert.equal(isGoogleReconnectRequired({ oauth_provider: 'google', oauth_reconnect_required: false }), false);
    assert.equal(isGoogleReconnectRequired({ oauth_provider: 'google', oauth_reconnect_required: 'true' }), false);
    assert.equal(isGoogleReconnectRequired({ oauth_provider: 'microsoft', oauth_reconnect_required: true }), false);
    assert.equal(isGoogleReconnectRequired({ oauth_reconnect_required: true }), false);
    assert.equal(isGoogleReconnectRequired(null), false);
    assert.equal(isGoogleReconnectRequired(undefined), false);
  });
});

describe('parseOAuthResult', () => {
  it('returns null when no OAuth result is present', () => {
    assert.equal(parseOAuthResult(params('')), null);
    assert.equal(parseOAuthResult(params('m=123&oidc_success=linked')), null);
    assert.equal(parseOAuthResult(null), null);
    assert.equal(parseOAuthResult(undefined), null);
  });

  it('maps a created Google mailbox', () => {
    assert.deepEqual(parseOAuthResult(params('oauth_success=google&oauth_result=created')), {
      provider: 'google', status: 'success', messageKey: 'admin.integrations.google.resultCreated',
    });
  });

  it('maps an updated Google mailbox', () => {
    assert.deepEqual(parseOAuthResult(params('oauth_success=google&oauth_result=updated')), {
      provider: 'google', status: 'success', messageKey: 'admin.integrations.google.resultUpdated',
    });
  });

  it('maps a Google success with a missing or unknown result to the generic connected key', () => {
    for (const q of ['oauth_success=google', 'oauth_success=google&oauth_result=<script>']) {
      assert.deepEqual(parseOAuthResult(params(q)), {
        provider: 'google', status: 'success', messageKey: 'admin.integrations.google.resultConnected',
      }, q);
    }
  });

  const errorCases = {
    access_denied: 'admin.integrations.google.errorAccessDenied',
    invalid_state: 'admin.integrations.google.errorInvalidState',
    not_configured: 'admin.integrations.google.errorNotConfigured',
    email_not_verified: 'admin.integrations.google.errorEmailNotVerified',
    missing_refresh_token: 'admin.integrations.google.errorMissingRefreshToken',
    scope_missing: 'admin.integrations.google.errorScopeMissing',
    authentication_failed: 'admin.integrations.google.errorAuthenticationFailed',
  };
  for (const [code, key] of Object.entries(errorCases)) {
    it(`maps the Google error code ${code}`, () => {
      assert.deepEqual(parseOAuthResult(params(`oauth_error=${code}&oauth_provider=google`)), {
        provider: 'google', status: 'error', messageKey: key,
      });
    });
  }

  it('maps an unknown Google error code to the generic Google failure key', () => {
    for (const q of [
      'oauth_error=invalid_grant&oauth_provider=google',
      'oauth_error=Token%20ya29.secret%20leaked&oauth_provider=google',
      'oauth_error=__proto__&oauth_provider=google',
      'oauth_error=toString&oauth_provider=google',
    ]) {
      assert.deepEqual(parseOAuthResult(params(q)), {
        provider: 'google', status: 'error', messageKey: 'admin.integrations.google.errorGeneric',
      }, q);
    }
  });

  it('maps non-Google providers to generic keys', () => {
    assert.deepEqual(parseOAuthResult(params('oauth_success=microsoft')), {
      provider: 'other', status: 'success', messageKey: 'admin.integrations.oauthGenericSuccess',
    });
    // Microsoft errors carry no oauth_provider.
    assert.deepEqual(parseOAuthResult(params('oauth_error=access_denied')), {
      provider: 'other', status: 'error', messageKey: 'admin.integrations.oauthGenericError',
    });
    assert.deepEqual(parseOAuthResult(params('oauth_error=access_denied&oauth_provider=microsoft')), {
      provider: 'other', status: 'error', messageKey: 'admin.integrations.oauthGenericError',
    });
  });

  it('prefers the error when both success and error are present', () => {
    assert.deepEqual(parseOAuthResult(params('oauth_success=google&oauth_result=created&oauth_error=invalid_state&oauth_provider=google')), {
      provider: 'google', status: 'error', messageKey: 'admin.integrations.google.errorInvalidState',
    });
  });

  it('never returns raw query text', () => {
    const raw = 'ya29.a0AfH6SMsecret';
    const result = parseOAuthResult(params(`oauth_error=${raw}&oauth_provider=google&oauth_result=${raw}`));
    assert.equal(JSON.stringify(result).includes(raw), false);
  });

  it('accepts a plain query string', () => {
    assert.deepEqual(parseOAuthResult('?oauth_success=google&oauth_result=created'), {
      provider: 'google', status: 'success', messageKey: 'admin.integrations.google.resultCreated',
    });
  });
});

describe('oauthMessageToSearchParams', () => {
  it('converts a popup success message', () => {
    const p = oauthMessageToSearchParams({ type: 'oauth_success', provider: 'google', result: 'updated' });
    assert.deepEqual(parseOAuthResult(p), {
      provider: 'google', status: 'success', messageKey: 'admin.integrations.google.resultUpdated',
    });
  });

  it('converts a popup error message', () => {
    const p = oauthMessageToSearchParams({ type: 'oauth_error', provider: 'google', error: 'scope_missing' });
    assert.deepEqual(parseOAuthResult(p), {
      provider: 'google', status: 'error', messageKey: 'admin.integrations.google.errorScopeMissing',
    });
  });

  it('keeps the legacy Microsoft message shapes generic', () => {
    assert.equal(parseOAuthResult(oauthMessageToSearchParams({ type: 'oauth_success', provider: 'microsoft' })).provider, 'other');
    assert.equal(parseOAuthResult(oauthMessageToSearchParams({ type: 'oauth_error', error: 'x' })).provider, 'other');
  });

  it('ignores unrelated or malformed messages', () => {
    for (const data of [null, undefined, 'oauth_success', {}, { type: 'other', provider: 'google' }, { type: 'oauth_success', provider: { a: 1 } }]) {
      assert.equal(parseOAuthResult(oauthMessageToSearchParams(data)), null, JSON.stringify(data));
    }
  });
});

describe('client secret field', () => {
  it('uses the backend redaction sentinel', () => {
    assert.equal(REDACTED_CLIENT_SECRET, '•'.repeat(8));
  });

  it('clears the redacted sentinel on focus and remembers it was redacted', () => {
    assert.deepEqual(secretFieldOnFocus(REDACTED_CLIENT_SECRET), { value: '', wasRedacted: true });
  });

  it('leaves a typed or empty value untouched on focus', () => {
    assert.deepEqual(secretFieldOnFocus('typed-secret'), { value: 'typed-secret', wasRedacted: false });
    assert.deepEqual(secretFieldOnFocus(''), { value: '', wasRedacted: false });
  });

  it('restores the sentinel on blur only when a redacted field was left empty', () => {
    assert.equal(secretFieldOnBlur('', true), REDACTED_CLIENT_SECRET);
    assert.equal(secretFieldOnBlur('new-secret', true), 'new-secret');
    assert.equal(secretFieldOnBlur('', false), '');
    assert.equal(secretFieldOnBlur('abc', false), 'abc');
  });

  it('accepts the exact sentinel and plain secrets for save', () => {
    assert.deepEqual(resolveClientSecretForSave(REDACTED_CLIENT_SECRET), { ok: true, value: REDACTED_CLIENT_SECRET });
    assert.deepEqual(resolveClientSecretForSave('GOCSPX-abc'), { ok: true, value: 'GOCSPX-abc' });
  });

  it('rejects empty values and values mixing the sentinel with other characters', () => {
    for (const value of ['', null, undefined, `${REDACTED_CLIENT_SECRET}abc`, `abc${REDACTED_CLIENT_SECRET}`, '•abc']) {
      assert.equal(resolveClientSecretForSave(value).ok, false, JSON.stringify(value));
    }
    assert.equal(resolveClientSecretForSave(`${REDACTED_CLIENT_SECRET}abc`).reason, 'invalid');
    assert.equal(resolveClientSecretForSave('').reason, 'required');
  });
});
