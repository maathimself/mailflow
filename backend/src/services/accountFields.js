import { sanitizeSignature } from './emailSanitizer.js';

// Fields safe to return to the client — matches the GET list, excludes credentials and tokens
export const SAFE_FIELDS = [
  'id', 'name', 'sender_name', 'email_address', 'color', 'protocol',
  'imap_host', 'imap_port', 'imap_skip_tls_verify',
  'smtp_host', 'smtp_port', 'smtp_tls',
  'auth_user', 'oauth_provider', 'enabled',
  'last_sync', 'sync_error', 'sort_order', 'folder_mappings',
  'signature', 'created_at', 'categorization_enabled',
  'gtd_enabled', 'gtd_folders',
];

export function safeAccount(row) {
  const obj = Object.fromEntries(SAFE_FIELDS.map(k => [k, row[k]]));
  // Sanitize on read so legacy values stored before the write-time sanitizer are safe
  if (obj.signature) obj.signature = sanitizeSignature(obj.signature);
  return obj;
}
