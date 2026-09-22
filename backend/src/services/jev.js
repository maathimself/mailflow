import { query } from './db.js';
import { decrypt, encrypt } from './encryption.js';

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const MAX_REQUEST_BYTES = 16_384;
const CALL_TIMEOUT_MS = 3_000;

export async function getJevStatus(userId) {
  const result = await query("SELECT config FROM user_integrations WHERE user_id = $1 AND provider = 'jev'", [userId]);
  return { configured: !!result.rows[0]?.config?.apiKey };
}

export async function saveJevKey(userId, apiKey) {
  if (typeof apiKey !== 'string' || !apiKey.trim() || apiKey.length > 512 || /[\r\n\0]/.test(apiKey)) {
    throw new TypeError('Invalid Jev API key');
  }
  const encrypted = encrypt(apiKey.trim());
  await query(`INSERT INTO user_integrations (user_id, provider, config)
    VALUES ($1, 'jev', $2) ON CONFLICT (user_id, provider)
    DO UPDATE SET config = EXCLUDED.config, updated_at = NOW()`, [userId, { apiKey: encrypted }]);
}

export async function removeJevKey(userId) {
  await query("DELETE FROM user_integrations WHERE user_id = $1 AND provider = 'jev'", [userId]);
}

export async function getJevKey(userId) {
  const result = await query("SELECT config FROM user_integrations WHERE user_id = $1 AND provider = 'jev'", [userId]);
  const stored = result.rows[0]?.config?.apiKey;
  if (typeof stored !== 'string' || !stored.startsWith('enc:')) return null;
  return decrypt(stored) || null;
}

function boundedState(message, question) {
  const field = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : '';
  const state = {
    from: field(message.fromEmail || message.from_email, 512),
    to: Array.isArray(message.to) ? message.to.slice(0, 20).map(a => field(a.email || a.address, 320)) : [],
    subject: field(message.subject, 1000),
    body: field(message.body, 12_000),
  };
  const payload = { state, model: 'jev-1.13.0', questions: { match: { type: 'noul', instructions: question } } };
  let body = JSON.stringify(payload);
  while (Buffer.byteLength(body) > MAX_REQUEST_BYTES && state.body.length) {
    state.body = state.body.slice(0, Math.floor(state.body.length * 0.75));
    body = JSON.stringify(payload);
  }
  return Buffer.byteLength(body) <= MAX_REQUEST_BYTES ? body : null;
}

export async function evaluateJev(apiKey, question, message, { timeoutMs = CALL_TIMEOUT_MS } = {}) {
  const unavailable = { probability: null, available: false };
  if (!apiKey || typeof question !== 'string' || !question.trim() || !message?.body?.trim()) return unavailable;
  const body = boundedState(message, question);
  if (!body) return unavailable;
  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(Math.min(timeoutMs, CALL_TIMEOUT_MS)),
    });
    if (!response.ok) return unavailable;
    const data = await response.json();
    const answer = data?.answers?.match;
    if (answer?.type !== 'noul' || typeof answer.noul !== 'number' ||
        !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) return unavailable;
    return { probability: answer.noul, available: true };
  } catch {
    return unavailable;
  }
}
