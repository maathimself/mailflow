import { ImapFlow } from 'imapflow';
import { makeClientCfg } from './imapManager.js';
import { resolveForConnection } from './hostValidation.js';
import { getConnectionPolicy } from './connectionPolicy.js';
import { buildSmtpTransport } from './mail/smtp.js';
import { sanitizeConnectionError } from './connectionErrors.js';

const CONNECTION_TIMEOUT_MS = 10_000;

function withTimeout(operation, onTimeout) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try {
        onTimeout?.();
      } finally {
        reject(new Error('Connection test timed out after 10 seconds'));
      }
    }, CONNECTION_TIMEOUT_MS);
  });
  return Promise.race([operation, timeout]).finally(() => clearTimeout(timer));
}

async function probeImap(account) {
  let client;
  let connected = false;
  try {
    const policy = await getConnectionPolicy();
    const resolved = await resolveForConnection(account.imap_host, {
      allowPrivate: policy.allowPrivateHosts,
    });
    const cfg = makeClientCfg(account, resolved, {
      enableIdle: false,
      policy,
    });
    client = new ImapFlow(cfg);
    await withTimeout(client.connect(), () => client.close());
    connected = true;
    return { ok: true };
  } catch (err) {
    return { ok: false, error: sanitizeConnectionError(err) };
  } finally {
    if (connected) {
      try {
        await client.logout();
      } catch {
        client.close();
      }
    } else {
      client?.close();
    }
  }
}

async function probeSmtp(account) {
  let transport;
  try {
    ({ transport } = await buildSmtpTransport(account));
    await withTimeout(transport.verify(), () => transport.close?.());
    return { ok: true };
  } catch (err) {
    return { ok: false, error: sanitizeConnectionError(err) };
  } finally {
    transport?.close?.();
  }
}

export async function testConnection(account) {
  const [imap, smtp] = await Promise.all([
    probeImap(account),
    probeSmtp(account),
  ]);
  return { imap, smtp };
}
