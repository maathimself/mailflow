import { query } from './db.js';

// Short-lived keys in PostgreSQL (the kv_store table), in place of the Redis MailFlow used
// before 4.4. It keeps the small part of the Redis client API the callers used, with the same
// answers, so a key past its expiry reads as absent and SET NX succeeds over it.
//
// Every statement is one round trip and atomic on its row: concurrent SET NX calls have exactly
// one winner, and concurrent INCRs never lose a count.

const LIVE = '(expires_at IS NULL OR expires_at > now())';
const EXPIRED = '(kv_store.expires_at IS NOT NULL AND kv_store.expires_at <= now())';
const expiry = (ms) => (ms == null ? null : Math.max(0, Math.round(ms)));

async function get(key) {
  const { rows } = await query(`SELECT value FROM kv_store WHERE key = $1 AND ${LIVE}`, [key]);
  return rows[0]?.value ?? null;
}

// Resolves 'OK' when written, or null when NX found a live key, as Redis does.
async function set(key, value, { NX = false, EX, PX } = {}) {
  const ms = expiry(PX ?? (EX != null ? EX * 1000 : null));
  const { rowCount } = await query(
    `INSERT INTO kv_store (key, value, expires_at)
     VALUES ($1, $2, CASE WHEN $3::bigint IS NULL THEN NULL ELSE now() + $3::bigint * interval '1 millisecond' END)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at
     ${NX ? `WHERE ${EXPIRED}` : ''}`,
    [key, String(value), ms]
  );
  return rowCount ? 'OK' : null;
}

async function del(keys) {
  const list = Array.isArray(keys) ? keys : [keys];
  const { rowCount } = await query('DELETE FROM kv_store WHERE key = ANY($1::text[])', [list]);
  return rowCount;
}

// INCRBY: an absent or expired key starts from 0 with no expiry.
async function incrBy(key, by) {
  const { rows } = await query(
    `INSERT INTO kv_store (key, value, expires_at) VALUES ($1, $2::bigint::text, NULL)
     ON CONFLICT (key) DO UPDATE SET
       value = CASE WHEN ${EXPIRED} THEN $2::bigint ELSE kv_store.value::bigint + $2::bigint END::text,
       expires_at = CASE WHEN ${EXPIRED} THEN NULL ELSE kv_store.expires_at END
     RETURNING value::bigint AS value`,
    [key, by]
  );
  return Number(rows[0].value);
}

// Resolves true when the key existed and now expires in ms.
async function pExpire(key, ms) {
  const { rowCount } = await query(
    `UPDATE kv_store SET expires_at = now() + $2::bigint * interval '1 millisecond' WHERE key = $1 AND ${LIVE}`,
    [key, expiry(ms)]
  );
  return rowCount > 0;
}

// Milliseconds left, -1 for a key with no expiry, -2 for an absent one, as Redis answers.
async function pTTL(key) {
  const { rows } = await query(
    `SELECT CASE WHEN expires_at IS NULL THEN -1
                 ELSE GREATEST(0, floor(extract(epoch FROM expires_at - clock_timestamp()) * 1000))
            END::bigint AS ttl
     FROM kv_store WHERE key = $1 AND ${LIVE}`,
    [key]
  );
  return rows.length ? Number(rows[0].ttl) : -2;
}

export const kv = {
  get,
  set,
  del,
  incr: key => incrBy(key, 1),
  decr: key => incrBy(key, -1),
  pExpire,
  pTTL,
};

// Expired rows read as absent already; this only keeps both tables from growing.
const SWEEP_MS = 10 * 60 * 1000;
let sweepTimer = null;

export async function sweepExpired() {
  await query('DELETE FROM kv_store WHERE expires_at IS NOT NULL AND expires_at <= now()');
  await query('DELETE FROM sessions WHERE expires_at <= now()');
}

export function startExpirySweep() {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    sweepExpired().catch(err => console.warn('Expired session/key sweep failed:', err.message));
  }, SWEEP_MS);
  sweepTimer.unref?.();
}

export function stopExpirySweep() {
  clearInterval(sweepTimer);
  sweepTimer = null;
}
