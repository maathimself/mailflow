function parseIpv4Literal(hostname) {
  const parts = String(hostname || '').split('.');
  if (parts.length !== 4) return null;

  const octets = parts.map((part) => {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null;
    const value = Number.parseInt(part, 10);
    return value <= 255 ? value : null;
  });

  return octets.some((part) => part === null) ? null : octets;
}

function isAllowedCleartextHostname(hostname) {
  const normalized = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === 'localhost' || normalized === '::1') return true;

  const octets = parseIpv4Literal(normalized);
  if (!octets) return false;

  return octets[0] === 127
    || octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168);
}

function normalizeHost(value) {
  const input = String(value || '').trim();
  const url = new URL(input);

  if (!['https:', 'http:'].includes(url.protocol)) {
    throw new Error('Host must start with https:// or http://');
  }
  if (url.protocol === 'http:' && !isAllowedCleartextHostname(url.hostname)) {
    throw new Error('Public MailFlow hosts must use https://');
  }

  url.username = '';
  url.password = '';
  url.hash = '';
  url.search = '';
  url.pathname = '/';

  return url.toString().replace(/\/$/, '');
}

function isSameOrigin(configuredHost, candidateUrl) {
  try {
    return new URL(candidateUrl).origin === new URL(configuredHost).origin;
  } catch {
    return false;
  }
}

function isOidcStart(url) {
  return /^\/auth\/oidc\/[^/]+\/start\/?$/.test(url.pathname);
}

function isOidcCallback(url) {
  return /^\/auth\/oidc\/[^/]+\/callback\/?$/.test(url.pathname);
}

function isOidcCompletion(url) {
  return url.searchParams.has('oidc_success') || url.searchParams.has('oidc_error');
}

function createNavigationPolicy(getConfiguredHost, { oidcTimeoutMs = 10 * 60 * 1000, now = Date.now } = {}) {
  let oidcExpiresAt = 0;
  let oidcOrigins = new Set();

  const resetOidc = () => {
    oidcExpiresAt = 0;
    oidcOrigins = new Set();
  };

  const isOidcActive = () => {
    if (oidcExpiresAt > now()) return true;
    resetOidc();
    return false;
  };

  return {
    decide(kind, targetUrl) {
      let target;
      let configured;
      try {
        target = new URL(targetUrl);
        configured = new URL(getConfiguredHost());
      } catch {
        return 'block';
      }

      if (target.origin === configured.origin) {
        if (isOidcStart(target)) {
          oidcExpiresAt = now() + oidcTimeoutMs;
          oidcOrigins = new Set([configured.origin]);
        } else if (isOidcCompletion(target)) {
          resetOidc();
        } else if (isOidcActive() && !isOidcCallback(target)) {
          resetOidc();
        }
        return 'allow';
      }

      if (!isOidcActive()) return 'block';
      if (oidcOrigins.has(target.origin)) return 'allow';

      if (kind === 'redirect') {
        oidcOrigins.add(target.origin);
        return 'allow';
      }

      return 'block';
    },

    reset: resetOidc,
  };
}

function hasMatchingWindowsPublisher(installed, downloaded) {
  return installed?.status === 'Valid'
    && downloaded?.status === 'Valid'
    && Boolean(installed.subject)
    && installed.subject === downloaded.subject;
}

function macTeamIdentifier(output) {
  return String(output || '').match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim() || null;
}

function hasMatchingMacTeam(installedOutput, downloadedOutput) {
  const installedTeam = macTeamIdentifier(installedOutput);
  return Boolean(installedTeam) && installedTeam === macTeamIdentifier(downloadedOutput);
}

module.exports = {
  createNavigationPolicy,
  hasMatchingMacTeam,
  hasMatchingWindowsPublisher,
  isAllowedCleartextHostname,
  isSameOrigin,
  normalizeHost,
};
