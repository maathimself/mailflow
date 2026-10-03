import { isIP } from 'node:net';
import { query } from './db.js';
import { decrypt, encrypt } from './encryption.js';
import { resolveForConnection } from './hostValidation.js';

export const MAIL_PROXY_KEY = 'outbound_mail_proxy';
const defaults = { enabled: false, type: 'http', host: '', port: 8080, allowPrivate: false, username: '', password: '' };

export async function getMailProxySettings() {
  const result = await query('SELECT value FROM system_settings WHERE key = $1', [MAIL_PROXY_KEY]);
  return result.rows.length ? { ...defaults, ...JSON.parse(result.rows[0].value) } : { ...defaults };
}

export function publicMailProxySettings(settings) {
  const { username, password, ...safe } = settings;
  return { ...safe, hasUsername: !!username, hasPassword: !!password };
}

export async function prepareMailProxySettings(input, previous) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid proxy settings');
  const next = { ...previous };
  for (const key of ['enabled', 'allowPrivate']) {
    if (key in input) {
      if (typeof input[key] !== 'boolean') throw new Error(`${key} must be boolean`);
      next[key] = input[key];
    }
  }
  if ('type' in input) {
    if (input.type !== 'http') throw new Error('Only HTTP CONNECT proxies are supported');
    next.type = input.type;
  }
  if ('host' in input) {
    if (typeof input.host !== 'string') throw new Error('Proxy host must be a hostname or IP address');
    next.host = input.host.trim().replace(/^\[|\]$/g, '');
    if (next.host && !isIP(next.host) && !/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(next.host)) {
      throw new Error('Proxy host must be a hostname or IP address, without a URL or credentials');
    }
  }
  if ('port' in input) {
    const port = Number(input.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Proxy port must be between 1 and 65535');
    next.port = port;
  }
  for (const key of ['username', 'password']) {
    if (key in input) {
      if (typeof input[key] !== 'string' || input[key].length > 1024 || /[\r\n\0]/.test(input[key])) throw new Error(`Invalid proxy ${key}`);
      next[key] = input[key] ? encrypt(input[key]) : '';
    }
  }
  if (next.enabled) {
    if (!next.host) throw new Error('Proxy host is required');
    await resolveForConnection(next.host, { allowPrivate: next.allowPrivate });
  }
  return next;
}

export function proxyError(message, code = 'MAIL_PROXY_UNAVAILABLE') {
  return Object.assign(new Error(message), { code, stage: 'proxy' });
}

export async function getAccountProxyUrl(account, protocol) {
  if (!account[`${protocol}_use_proxy`]) return undefined;
  const settings = await getMailProxySettings();
  if (!settings.enabled) throw proxyError('The outbound mail proxy is disabled. Enable it or select a direct connection.');
  let resolved;
  try {
    resolved = await resolveForConnection(settings.host, { allowPrivate: settings.allowPrivate });
  } catch {
    throw proxyError('The configured proxy endpoint is blocked by the connection policy.');
  }
  const bare = resolved.host.replace(/^\[|\]$/g, '');
  if (!isIP(bare)) throw proxyError('The configured proxy endpoint could not be resolved.');
  const url = new URL(`http://${isIP(bare) === 6 ? `[${bare}]` : bare}:${settings.port}`);
  for (const key of ['username', 'password']) {
    const value = decrypt(settings[key]);
    if (settings[key] && !value) throw proxyError('Proxy credentials could not be decrypted. Re-enter them in admin settings.');
    url[key] = value ? encodeURIComponent(value) : '';
  }
  return url.href;
}

// CONNECT must receive a validated IP, never a hostname for the proxy to resolve again.
export function assertProxyDestination(resolved) {
  if (!isIP(resolved.host.replace(/^\[|\]$/g, ''))) {
    throw new Error('Mail server hostname could not be resolved to a validated address');
  }
}

export function mailConnectionError(err, proxyUrl) {
  let endpointFailure = false;
  if (proxyUrl) {
    const endpoint = new URL(proxyUrl);
    const cause = err?._err || err;
    endpointFailure = cause?.syscall === 'connect' && cause.address === endpoint.hostname.replace(/^\[|\]$/g, '') && Number(cause.port) === Number(endpoint.port);
  }
  const proxy = endpointFailure || err?.stage === 'proxy' || /proxy/i.test(err?.code || '') || /proxy|CONNECT response/i.test(err?.message || '');
  if (proxy) {
    const auth = /407|authentication|auth/i.test([err?.message, err?._err?.message].join(' '));
    return { stage: 'proxy', error: auth ? 'Proxy authentication failed. Check the proxy credentials.' : 'Outbound mail proxy connection failed. Check its settings and backend connectivity.' };
  }
  return { stage: 'provider', error: 'Mail server connection or authentication failed. Check the server settings, credentials and TLS policy.' };
}
