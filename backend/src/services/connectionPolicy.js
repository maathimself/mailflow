import { query } from './db.js';

// Reads the three server-level connection policy flags from system_settings.
// Called once per connection attempt — keeps validation and connection code
// free of direct DB coupling.
export async function getConnectionPolicy() {
  const result = await query(
    `SELECT key, value FROM system_settings
     WHERE key IN ('allow_private_hosts', 'allow_insecure_tls', 'allow_nonstandard_ports')`
  );
  const map = {};
  for (const row of result.rows) map[row.key] = row.value === 'true';
  return {
    allowPrivateHosts:      !!map.allow_private_hosts,
    allowInsecureTls:       !!map.allow_insecure_tls,
    allowNonstandardPorts:  !!map.allow_nonstandard_ports,
  };
}
