const errorKeys = {
  'Invalid webhook URL': 'webhooks.errors.url',
  'Use an HTTP(S) URL without credentials or a fragment': 'webhooks.errors.urlScheme',
  'Invalid webhook administration settings': 'webhooks.errors.settings',
  'Allowed destinations must be origins without a path or query': 'webhooks.errors.origin',
  'Invalid webhook settings': 'webhooks.errors.settings',
  'Unknown webhook setting': 'webhooks.errors.settings',
  'Invalid webhook setting': 'webhooks.errors.settings',
  'Invalid webhook format': 'webhooks.errors.format',
  'Webhooks are disabled by the administrator': 'webhooks.unavailable',
  'Tokens are only supported by the ntfy and Gotify presets': 'webhooks.errors.tokenPreset',
  'Public webhook URLs must use HTTPS': 'webhooks.errors.https',
  'Configure a webhook URL before enabling notifications': 'webhooks.errors.urlRequired',
  'Invalid webhook token': 'webhooks.errors.token',
  'Session authentication required': 'webhooks.errors.session',
  'Not authenticated': 'webhooks.errors.session',
  'Admin access required': 'webhooks.errors.admin',
  'Delivery timed out': 'webhooks.errors.timeout',
  'Destination blocked by network policy': 'webhooks.errors.blocked',
  'Delivery failed': 'webhooks.errors.delivery',
};

// Also translate stored delivery errors from earlier server versions.
export function webhookErrorText(error, t) {
  const message = typeof error === 'string' ? error : error?.message;
  if (error?.code === 'rate_limit') return t('webhooks.errors.rateLimit');
  if (error?.code === 'disabled') return t('webhooks.errors.disabled');
  if (error?.code === 'unavailable') return t('webhooks.errors.unavailable');
  const http = /^Endpoint returned HTTP (\d{3})$/.exec(message || '');
  if (http) return t('webhooks.errors.http', { status: http[1] });
  return t(Object.hasOwn(errorKeys, message) ? errorKeys[message] : 'webhooks.errors.request');
}
