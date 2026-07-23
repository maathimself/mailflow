// Behavioral reference: pi-mono's MIT-licensed OpenAI Codex OAuth adapter
// (packages/ai/src/auth/oauth/openai-codex.ts). Bounded response handling and
// restart-safe state transitions follow the hardening patterns documented by
// OpenClaw's openai-chatgpt-device-code implementation.

import crypto from 'crypto';
import { createRequestSignal, parseJson, readLimited, sanitizeText } from './aiHttp.js';
import { decrypt, encrypt } from './encryption.js';
import { query, withTransaction } from './db.js';

export const OPENAI_CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const OPENAI_CODEX_DEVICE_URL = 'https://auth.openai.com/codex/device';

const AUTH_BASE_URL = 'https://auth.openai.com';
const DEVICE_CODE_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/usercode`;
const DEVICE_TOKEN_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/token`;
const TOKEN_URL = `${AUTH_BASE_URL}/oauth/token`;
const DEVICE_REDIRECT_URI = `${AUTH_BASE_URL}/deviceauth/callback`;
const DEVICE_TIMEOUT_MS = 15 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_INTERVAL_MS = 5000;
const MIN_INTERVAL_MS = 1000;
const MAX_INTERVAL_MS = 60_000;
const SLOW_DOWN_MS = 5000;
const POLL_CLAIM_STALE_MS = 30_000;
const REFRESH_SKEW_MS = 60_000;
const JSON_BODY_LIMIT_BYTES = 256 * 1024;
const ERROR_BODY_LIMIT_BYTES = 8 * 1024;
const TERMINAL_REFRESH_ERRORS = new Set(['invalid_grant', 'invalid_client', 'unauthorized_client']);

export class CodexAuthError extends Error {
  constructor(message, { status = 400, code, transient = false } = {}) {
    super(message);
    this.name = 'CodexAuthError';
    this.status = status;
    this.code = code;
    this.transient = transient;
  }
}

export function hashSessionId(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) throw new CodexAuthError('Session is required', { status: 401 });
  return crypto.createHash('sha256').update(sessionId).digest('hex');
}

export function decodeJwtClaims(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

export function extractChatGptAccount(claims) {
  if (!claims || typeof claims !== 'object') throw new CodexAuthError('ChatGPT token has no account information');
  const auth = claims['https://api.openai.com/auth'];
  const profile = claims['https://api.openai.com/profile'];
  const accountId = typeof auth?.chatgpt_account_id === 'string'
    ? auth.chatgpt_account_id
    : (typeof claims.chatgpt_account_id === 'string' ? claims.chatgpt_account_id : '');
  if (!accountId) throw new CodexAuthError('ChatGPT token has no account ID');
  const email = typeof profile?.email === 'string'
    ? profile.email
    : (typeof claims.email === 'string' ? claims.email : (typeof auth?.email === 'string' ? auth.email : ''));
  return { accountId, email };
}

function maskAccountLabel(value) {
  if (typeof value !== 'string' || !value) return '';
  const at = value.indexOf('@');
  if (at > 0) return `${value[0]}***${value.slice(at)}`;
  return value.length <= 4 ? '••••' : `${value.slice(0, 2)}••••${value.slice(-2)}`;
}

function responseErrorCode(body) {
  const error = body?.error;
  if (typeof error === 'string') return error;
  if (error && typeof error.code === 'string') return error.code;
  return '';
}

function authHeaders(contentType) {
  return {
    'Content-Type': contentType,
    originator: 'mailflow',
    'User-Agent': 'Mailflow',
  };
}

async function fetchAuthResponse(fetchFn, url, init, timeoutMs = REQUEST_TIMEOUT_MS) {
  const requestSignal = createRequestSignal(null, timeoutMs, 'request timeout');
  try {
    const response = await fetchFn(url, { ...init, signal: requestSignal.signal });
    const text = await readLimited(response, response.ok ? JSON_BODY_LIMIT_BYTES : ERROR_BODY_LIMIT_BYTES);
    return { response, text };
  } catch (error) {
    if (requestSignal.timedOut()) throw new CodexAuthError('ChatGPT authorization request timed out', { transient: true });
    throw new CodexAuthError(`ChatGPT authorization network error: ${sanitizeText(error?.message, 300) || 'request failed'}`, {
      transient: true,
    });
  } finally {
    requestSignal.cleanup();
  }
}

function intervalMilliseconds(raw) {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_INTERVAL_MS;
  const seconds = typeof raw === 'string' ? Number(raw.trim()) : raw;
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.round(seconds * 1000)));
}

function encryptedJson(value, encryptFn) {
  return encryptFn(JSON.stringify(value));
}

function decryptedJson(value, decryptFn) {
  const plaintext = decryptFn(value);
  if (!plaintext) throw new CodexAuthError('Stored ChatGPT authorization is unavailable', { status: 503 });
  try {
    return JSON.parse(plaintext);
  } catch {
    throw new CodexAuthError('Stored ChatGPT authorization is corrupted', { status: 503 });
  }
}

function rowToFlow(row) {
  if (!row) return null;
  const time = (value) => value instanceof Date ? value.getTime() : new Date(value).getTime();
  return {
    id: row.id,
    adminUserId: row.admin_user_id,
    sessionHash: row.session_hash,
    deviceAuthIdEnc: row.device_auth_id_enc,
    userCodeEnc: row.user_code_enc,
    authorizationCodeEnc: row.authorization_code_enc,
    codeVerifierEnc: row.code_verifier_enc,
    intervalMs: row.interval_ms,
    expiresAt: time(row.expires_at),
    nextPollAt: time(row.next_poll_at),
    state: row.state,
    failureCode: row.failure_code,
    createdAt: time(row.created_at),
    updatedAt: time(row.updated_at),
  };
}

export function createPostgresCodexStore() {
  return {
    async createFlow(flow) {
      return withTransaction(async (client) => {
        await client.query(
          'SELECT id FROM users WHERE id = $1 FOR UPDATE',
          [flow.adminUserId],
        );
        await client.query(
          `UPDATE ai_codex_device_flows
           SET state = 'cancelled', device_auth_id_enc = NULL, user_code_enc = NULL,
               authorization_code_enc = NULL, code_verifier_enc = NULL, updated_at = NOW()
           WHERE admin_user_id = $1 AND session_hash = $2
             AND state IN ('pending', 'polling', 'authorized')`,
          [flow.adminUserId, flow.sessionHash],
        );
        await client.query(
          `DELETE FROM ai_codex_device_flows
           WHERE expires_at < NOW() - INTERVAL '1 day'`,
        );
        const result = await client.query(
          `INSERT INTO ai_codex_device_flows
             (admin_user_id, session_hash, device_auth_id_enc, user_code_enc,
              interval_ms, expires_at, next_poll_at, state, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8, $8)
           RETURNING *`,
          [
            flow.adminUserId, flow.sessionHash, flow.deviceAuthIdEnc, flow.userCodeEnc,
            flow.intervalMs, new Date(flow.expiresAt), new Date(flow.nextPollAt), new Date(flow.createdAt),
          ],
        );
        return rowToFlow(result.rows[0]);
      });
    },

    async claimFlow({ id, adminUserId, sessionHash, now, staleBefore }) {
      return withTransaction(async (client) => {
        const result = await client.query(
          `SELECT * FROM ai_codex_device_flows
           WHERE id = $1 AND admin_user_id = $2 AND session_hash = $3
           FOR UPDATE`,
          [id, adminUserId, sessionHash],
        );
        const flow = rowToFlow(result.rows[0]);
        if (!flow) return { kind: 'not_found' };
        if (['pending', 'polling', 'authorized'].includes(flow.state) && flow.expiresAt <= now) {
          await client.query(
            `UPDATE ai_codex_device_flows
             SET state = 'expired', device_auth_id_enc = NULL, user_code_enc = NULL,
                 authorization_code_enc = NULL, code_verifier_enc = NULL, updated_at = $2
             WHERE id = $1`,
            [id, new Date(now)],
          );
          return { kind: 'terminal', state: 'expired' };
        }
        if (['completed', 'cancelled', 'expired', 'failed'].includes(flow.state)) {
          return { kind: 'terminal', state: flow.state, failureCode: flow.failureCode };
        }
        if (flow.state === 'pending' && flow.nextPollAt > now) {
          return { kind: 'waiting', retryAfterMs: flow.nextPollAt - now };
        }
        if (flow.state === 'polling' && flow.updatedAt > staleBefore) {
          return { kind: 'waiting', retryAfterMs: MIN_INTERVAL_MS };
        }
        await client.query(
          `UPDATE ai_codex_device_flows SET state = 'polling', updated_at = $2 WHERE id = $1`,
          [id, new Date(now)],
        );
        return { kind: 'claimed', flow: { ...flow, state: 'polling', updatedAt: now } };
      });
    },

    async releaseFlow({ id, state, intervalMs, nextPollAt, failureCode, clearSecrets = false }) {
      await query(
        `UPDATE ai_codex_device_flows
         SET state = $2,
             interval_ms = COALESCE($3, interval_ms),
             next_poll_at = COALESCE($4, next_poll_at),
             failure_code = $5,
             device_auth_id_enc = CASE WHEN $6 THEN NULL ELSE device_auth_id_enc END,
             user_code_enc = CASE WHEN $6 THEN NULL ELSE user_code_enc END,
             authorization_code_enc = CASE WHEN $6 THEN NULL ELSE authorization_code_enc END,
             code_verifier_enc = CASE WHEN $6 THEN NULL ELSE code_verifier_enc END,
             updated_at = NOW()
         WHERE id = $1 AND state IN ('polling', 'authorized')`,
        [id, state, intervalMs ?? null, nextPollAt === undefined ? null : new Date(nextPollAt), failureCode ?? null, clearSecrets],
      );
    },

    async authorizeFlow({ id, authorizationCodeEnc, codeVerifierEnc }) {
      const result = await query(
        `UPDATE ai_codex_device_flows
         SET state = 'authorized', authorization_code_enc = $2, code_verifier_enc = $3, updated_at = NOW()
         WHERE id = $1 AND state = 'polling'`,
        [id, authorizationCodeEnc, codeVerifierEnc],
      );
      return result.rowCount > 0;
    },

    async completeFlow({ id, encryptedCredential }) {
      return withTransaction(async (client) => {
        const lock = await client.query(
          `SELECT state FROM ai_codex_device_flows WHERE id = $1 FOR UPDATE`,
          [id],
        );
        if (!['polling', 'authorized'].includes(lock.rows[0]?.state)) return false;
        await client.query(
          `INSERT INTO ai_codex_credentials (singleton, encrypted_payload, updated_at)
           VALUES (TRUE, $1, NOW())
           ON CONFLICT (singleton) DO UPDATE SET encrypted_payload = $1, updated_at = NOW()`,
          [encryptedCredential],
        );
        await client.query(
          `UPDATE ai_codex_device_flows
           SET state = 'completed', device_auth_id_enc = NULL, user_code_enc = NULL,
               authorization_code_enc = NULL, code_verifier_enc = NULL,
               completed_at = NOW(), updated_at = NOW()
           WHERE id = $1`,
          [id],
        );
        return true;
      });
    },

    async cancelFlow({ id, adminUserId, sessionHash }) {
      const result = await query(
        `UPDATE ai_codex_device_flows
         SET state = 'cancelled',
             device_auth_id_enc = NULL, user_code_enc = NULL,
             authorization_code_enc = NULL, code_verifier_enc = NULL, updated_at = NOW()
         WHERE id = $1 AND admin_user_id = $2 AND session_hash = $3
           AND state IN ('pending', 'polling', 'authorized')
         RETURNING id`,
        [id, adminUserId, sessionHash],
      );
      return result.rows.length > 0;
    },

    async latestOwnedFlow({ adminUserId, sessionHash }) {
      const result = await query(
        `SELECT * FROM ai_codex_device_flows
         WHERE admin_user_id = $1 AND session_hash = $2
         ORDER BY created_at DESC LIMIT 1`,
        [adminUserId, sessionHash],
      );
      return rowToFlow(result.rows[0]);
    },

    async getCredential() {
      const result = await query('SELECT encrypted_payload FROM ai_codex_credentials WHERE singleton = TRUE');
      return result.rows[0]?.encrypted_payload || null;
    },

    async disconnect() {
      await withTransaction(async (client) => {
        await client.query(
          `UPDATE ai_codex_device_flows
           SET state = 'cancelled', device_auth_id_enc = NULL, user_code_enc = NULL,
               authorization_code_enc = NULL, code_verifier_enc = NULL, updated_at = NOW()
           WHERE state IN ('pending', 'polling', 'authorized')`,
        );
        await client.query('DELETE FROM ai_codex_credentials WHERE singleton = TRUE');
      });
    },

    async withCredentialLock(callback) {
      return withTransaction(async (client) => {
        const result = await client.query(
          'SELECT encrypted_payload FROM ai_codex_credentials WHERE singleton = TRUE FOR UPDATE',
        );
        return callback({
          encryptedCredential: result.rows[0]?.encrypted_payload || null,
          save: async (value) => {
            await client.query(
              `INSERT INTO ai_codex_credentials (singleton, encrypted_payload, updated_at)
               VALUES (TRUE, $1, NOW())
               ON CONFLICT (singleton) DO UPDATE SET encrypted_payload = $1, updated_at = NOW()`,
              [value],
            );
          },
        });
      });
    },
  };
}

function terminalPollResult(state, failureCode) {
  if (state === 'completed') return { status: 'connected' };
  if (state === 'failed') return { status: 'failed', reconnectRequired: true, reason: failureCode || 'authorization_failed' };
  return { status: state };
}

function credentialExpiry(tokenBody, claims, now) {
  const seconds = typeof tokenBody.expires_in === 'string' ? Number(tokenBody.expires_in) : tokenBody.expires_in;
  if (Number.isFinite(seconds) && seconds > 0) return now + seconds * 1000;
  if (Number.isFinite(claims?.exp) && claims.exp > 0) return claims.exp * 1000;
  throw new CodexAuthError('ChatGPT token response has no valid expiry');
}

export function createOpenAiCodexAuth({
  store = createPostgresCodexStore(),
  fetchFn = (...args) => fetch(...args),
  now = () => Date.now(),
  encryptFn = encrypt,
  decryptFn = decrypt,
} = {}) {
  let refreshInFlight = null;
  const owner = (userId, sessionId) => ({ adminUserId: userId, sessionHash: hashSessionId(sessionId) });

  function accessResult(credential) {
    if (credential?.state !== 'connected' || !credential.accessToken || !credential.accountId) {
      throw new CodexAuthError('ChatGPT authorization requires reconnection', { status: 401 });
    }
    return { accessToken: credential.accessToken, accountId: credential.accountId };
  }

  async function refreshUnderLock(forceRefresh) {
    return store.withCredentialLock(async ({ encryptedCredential, save }) => {
      if (!encryptedCredential) throw new CodexAuthError('ChatGPT is not connected', { status: 503 });
      const credential = decryptedJson(encryptedCredential, decryptFn);
      if (credential.state !== 'connected') {
        return { error: new CodexAuthError('ChatGPT authorization requires reconnection', {
          status: 401,
          code: credential.failureCode,
        }) };
      }
      if (!forceRefresh && credential.expiresAt > now() + REFRESH_SKEW_MS) {
        return accessResult(credential);
      }
      if (!credential.refreshToken) {
        const failureCode = 'missing_refresh_token';
        await save(encryptedJson({
          ...credential,
          state: 'reconnect_required',
          accessToken: null,
          refreshToken: null,
          failureCode,
        }, encryptFn));
        return { error: new CodexAuthError('ChatGPT authorization requires reconnection', {
          status: 401,
          code: failureCode,
        }) };
      }

      const { response, text } = await fetchAuthResponse(fetchFn, TOKEN_URL, {
        method: 'POST',
        headers: authHeaders('application/x-www-form-urlencoded'),
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: OPENAI_CODEX_CLIENT_ID,
          refresh_token: credential.refreshToken,
        }),
      });
      const body = parseJson(text);

      if (!response.ok) {
        const upstreamCode = sanitizeText(responseErrorCode(body), 100);
        if (TERMINAL_REFRESH_ERRORS.has(upstreamCode)) {
          await save(encryptedJson({
            ...credential,
            state: 'reconnect_required',
            accessToken: null,
            refreshToken: null,
            failureCode: upstreamCode,
          }, encryptFn));
          return { error: new CodexAuthError('ChatGPT authorization expired; reconnect required', {
            status: 401,
            code: upstreamCode,
          }) };
        }
        throw new CodexAuthError(`ChatGPT token refresh failed (${response.status})`, {
          status: 502,
          code: upstreamCode || undefined,
          transient: true,
        });
      }

      if (typeof body?.access_token !== 'string' || !body.access_token) {
        throw new CodexAuthError('Invalid ChatGPT token refresh response', { status: 502, transient: true });
      }
      const nextRefreshToken = typeof body.refresh_token === 'string' && body.refresh_token
        ? body.refresh_token
        : credential.refreshToken;
      let claims;
      let account;
      try {
        claims = decodeJwtClaims(body.access_token);
        account = extractChatGptAccount(claims);
      } catch {
        throw new CodexAuthError('Invalid ChatGPT token refresh identity', { status: 502, transient: true });
      }
      let expiresAt;
      try {
        expiresAt = credentialExpiry(body, claims, now());
      } catch {
        throw new CodexAuthError('Invalid ChatGPT token refresh expiry', { status: 502, transient: true });
      }
      const refreshed = {
        state: 'connected',
        accessToken: body.access_token,
        refreshToken: nextRefreshToken,
        expiresAt,
        accountId: account.accountId,
        accountLabel: maskAccountLabel(account.email || credential.accountLabel || account.accountId),
        failureCode: null,
      };
      await save(encryptedJson(refreshed, encryptFn));
      return accessResult(refreshed);
    });
  }

  async function getAccess({ forceRefresh = false } = {}) {
    const encryptedCredential = await store.getCredential();
    if (!encryptedCredential) throw new CodexAuthError('ChatGPT is not connected', { status: 503 });
    const credential = decryptedJson(encryptedCredential, decryptFn);
    if (credential.state !== 'connected') {
      throw new CodexAuthError('ChatGPT authorization requires reconnection', {
        status: 401,
        code: credential.failureCode,
      });
    }
    if (!forceRefresh && credential.expiresAt > now() + REFRESH_SKEW_MS) return accessResult(credential);

    if (!refreshInFlight) {
      refreshInFlight = refreshUnderLock(forceRefresh).finally(() => { refreshInFlight = null; });
    }
    const result = await refreshInFlight;
    if (result?.error) throw result.error;
    return result;
  }

  async function startDeviceFlow({ userId, sessionId }) {
    const { response, text } = await fetchAuthResponse(fetchFn, DEVICE_CODE_URL, {
      method: 'POST',
      headers: authHeaders('application/json'),
      body: JSON.stringify({ client_id: OPENAI_CODEX_CLIENT_ID }),
    });
    if (!response.ok) {
      throw new CodexAuthError(`ChatGPT device code request failed (${response.status})`, {
        status: 502,
        transient: response.status >= 500,
      });
    }
    const body = parseJson(text);
    const intervalMs = intervalMilliseconds(body?.interval);
    if (typeof body?.device_auth_id !== 'string' || !body.device_auth_id
        || typeof (body.user_code || body.usercode) !== 'string' || !(body.user_code || body.usercode)
        || intervalMs === null) {
      throw new CodexAuthError('Invalid device code response', { status: 502 });
    }
    const userCode = body.user_code || body.usercode;
    const startedAt = now();
    const flow = await store.createFlow({
      ...owner(userId, sessionId),
      deviceAuthIdEnc: encryptFn(body.device_auth_id),
      userCodeEnc: encryptFn(userCode),
      authorizationCodeEnc: null,
      codeVerifierEnc: null,
      intervalMs,
      expiresAt: startedAt + DEVICE_TIMEOUT_MS,
      nextPollAt: startedAt + intervalMs,
      state: 'pending',
      createdAt: startedAt,
    });
    return {
      flowId: flow.id,
      userCode,
      verificationUrl: OPENAI_CODEX_DEVICE_URL,
      intervalMs,
      expiresAt: flow.expiresAt,
      status: 'pending',
    };
  }

  async function releaseFailed(flowId, error, state = 'failed') {
    await store.releaseFlow({
      id: flowId,
      state,
      failureCode: error.code || (error.transient ? 'transient_error' : 'authorization_failed'),
      clearSecrets: state === 'failed',
    });
  }

  async function exchangeAuthorizedFlow(flow) {
    const authorizationCode = decryptFn(flow.authorizationCodeEnc);
    const codeVerifier = decryptFn(flow.codeVerifierEnc);
    if (!authorizationCode || !codeVerifier) throw new CodexAuthError('Stored ChatGPT exchange code is unavailable');
    const { response, text } = await fetchAuthResponse(fetchFn, TOKEN_URL, {
      method: 'POST',
      headers: authHeaders('application/x-www-form-urlencoded'),
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: OPENAI_CODEX_CLIENT_ID,
        code: authorizationCode,
        code_verifier: codeVerifier,
        redirect_uri: DEVICE_REDIRECT_URI,
      }),
    });
    if (!response.ok) {
      const code = responseErrorCode(parseJson(text));
      throw new CodexAuthError(`ChatGPT token exchange failed (${response.status})`, {
        status: 502,
        code: sanitizeText(code, 100) || undefined,
        transient: response.status >= 500,
      });
    }
    const body = parseJson(text);
    if (typeof body?.access_token !== 'string' || !body.access_token
        || typeof body.refresh_token !== 'string' || !body.refresh_token) {
      throw new CodexAuthError('Invalid ChatGPT token exchange response', { status: 502 });
    }
    const claims = decodeJwtClaims(body.access_token);
    const account = extractChatGptAccount(claims);
    const payload = {
      state: 'connected',
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresAt: credentialExpiry(body, claims, now()),
      accountId: account.accountId,
      accountLabel: maskAccountLabel(account.email || account.accountId),
      failureCode: null,
    };
    const completed = await store.completeFlow({
      id: flow.id,
      encryptedCredential: encryptedJson(payload, encryptFn),
    });
    return completed ? { status: 'connected' } : { status: 'cancelled' };
  }

  async function pollDeviceFlow({ flowId, userId, sessionId }) {
    const time = now();
    const claim = await store.claimFlow({
      id: flowId,
      ...owner(userId, sessionId),
      now: time,
      staleBefore: time - POLL_CLAIM_STALE_MS,
    });
    if (claim.kind === 'not_found') throw new CodexAuthError('Device authorization not found', { status: 404 });
    if (claim.kind === 'terminal') return terminalPollResult(claim.state, claim.failureCode);
    if (claim.kind === 'waiting') return { status: 'pending', retryAfterMs: Math.max(MIN_INTERVAL_MS, claim.retryAfterMs) };

    let flow = claim.flow;
    if (!flow.authorizationCodeEnc || !flow.codeVerifierEnc) {
      let response;
      let text;
      try {
        ({ response, text } = await fetchAuthResponse(fetchFn, DEVICE_TOKEN_URL, {
          method: 'POST',
          headers: authHeaders('application/json'),
          body: JSON.stringify({
            device_auth_id: decryptFn(flow.deviceAuthIdEnc),
            user_code: decryptFn(flow.userCodeEnc),
          }),
        }));
      } catch (error) {
        await releaseFailed(flow.id, error, 'pending');
        throw error;
      }
      const body = parseJson(text);
      if (!response.ok) {
        const code = responseErrorCode(body);
        if (response.status === 403 || response.status === 404 || code === 'deviceauth_authorization_pending') {
          const nextPollAt = now() + flow.intervalMs;
          await store.releaseFlow({ id: flow.id, state: 'pending', nextPollAt, failureCode: null });
          return { status: 'pending', retryAfterMs: flow.intervalMs };
        }
        if (code === 'slow_down') {
          const intervalMs = Math.min(MAX_INTERVAL_MS, flow.intervalMs + SLOW_DOWN_MS);
          await store.releaseFlow({ id: flow.id, state: 'pending', intervalMs, nextPollAt: now() + intervalMs, failureCode: null });
          return { status: 'pending', retryAfterMs: intervalMs };
        }
        const error = new CodexAuthError(`ChatGPT device authorization failed (${response.status})`, {
          status: 502,
          code: sanitizeText(code, 100) || undefined,
          transient: response.status >= 500,
        });
        await releaseFailed(flow.id, error, error.transient ? 'pending' : 'failed');
        throw error;
      }
      if (typeof body?.authorization_code !== 'string' || !body.authorization_code
          || typeof body.code_verifier !== 'string' || !body.code_verifier) {
        const error = new CodexAuthError('Invalid ChatGPT device authorization response', { status: 502 });
        await releaseFailed(flow.id, error);
        throw error;
      }
      const authorizationCodeEnc = encryptFn(body.authorization_code);
      const codeVerifierEnc = encryptFn(body.code_verifier);
      const authorized = await store.authorizeFlow({
        id: flow.id,
        authorizationCodeEnc,
        codeVerifierEnc,
      });
      if (!authorized) return { status: 'cancelled' };
      flow = {
        ...flow,
        authorizationCodeEnc,
        codeVerifierEnc,
        state: 'authorized',
      };
    }

    try {
      return await exchangeAuthorizedFlow(flow);
    } catch (error) {
      await releaseFailed(flow.id, error, error.transient ? 'authorized' : 'failed');
      throw error;
    }
  }

  async function cancelDeviceFlow({ flowId, userId, sessionId }) {
    const cancelled = await store.cancelFlow({ id: flowId, ...owner(userId, sessionId) });
    if (!cancelled) throw new CodexAuthError('Device authorization not found', { status: 404 });
    return { status: 'cancelled' };
  }

  async function getStatus({ userId, sessionId } = {}) {
    let credentialStatus = null;
    const encryptedCredential = await store.getCredential();
    if (encryptedCredential) {
      try {
        const credential = decryptedJson(encryptedCredential, decryptFn);
        if (credential.state === 'connected') {
          return {
            connected: true,
            state: 'connected',
            expiresAt: credential.expiresAt,
            accountLabel: maskAccountLabel(credential.accountLabel),
          };
        }
        credentialStatus = {
          connected: false,
          state: credential.state || 'reconnect_required',
          reconnectRequired: true,
          reason: credential.failureCode || 'authorization_expired',
        };
      } catch {
        credentialStatus = {
          connected: false,
          state: 'reconnect_required',
          reconnectRequired: true,
          reason: 'credential_unavailable',
        };
      }
    }
    if (userId && sessionId) {
      const flow = await store.latestOwnedFlow({ ...owner(userId, sessionId) });
      if (flow && ['pending', 'polling', 'authorized'].includes(flow.state) && flow.expiresAt > now()) {
        return {
          connected: false,
          state: 'pending',
          device: {
            flowId: flow.id,
            userCode: flow.userCodeEnc ? decryptFn(flow.userCodeEnc) : '',
            verificationUrl: OPENAI_CODEX_DEVICE_URL,
            expiresAt: flow.expiresAt,
            intervalMs: flow.intervalMs,
          },
        };
      }
    }
    return credentialStatus || { connected: false, state: 'disconnected', reconnectRequired: false };
  }

  async function disconnectCodex() {
    await store.disconnect();
    return { status: 'disconnected' };
  }

  return {
    startDeviceFlow,
    pollDeviceFlow,
    cancelDeviceFlow,
    getStatus,
    getAccess,
    disconnectCodex,
  };
}

const defaultService = createOpenAiCodexAuth();

export const startDeviceFlow = defaultService.startDeviceFlow;
export const pollDeviceFlow = defaultService.pollDeviceFlow;
export const cancelDeviceFlow = defaultService.cancelDeviceFlow;
export const getCodexStatus = defaultService.getStatus;
export const getCodexAccess = defaultService.getAccess;
export const disconnectCodex = defaultService.disconnectCodex;
