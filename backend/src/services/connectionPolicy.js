import { query } from './db.js';

const POLICY_TTL_MS = 30_000;
let _cache = null;
let _cacheAt = 0;

export async function getConnectionPolicy() {
  const now = Date.now();
  if (_cache && now - _cacheAt < POLICY_TTL_MS) return _cache;
  const result = await query(
    `SELECT key, value FROM system_settings
     WHERE key IN ('allow_private_hosts', 'allow_insecure_tls', 'allow_nonstandard_ports')`
  );
  const map = {};
  for (const row of result.rows) map[row.key] = row.value === 'true';
  _cache = {
    allowPrivateHosts:      !!map.allow_private_hosts,
    allowInsecureTls:       !!map.allow_insecure_tls,
    allowNonstandardPorts:  !!map.allow_nonstandard_ports,
  };
  _cacheAt = now;
  return _cache;
}

// Call after PATCH /settings to pick up changes without waiting for TTL.
export function invalidateConnectionPolicyCache() {
  _cache = null;
}
