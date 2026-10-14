// Storing a message body fetched from the mail server in the messages table, as the body route
// serves it from then on. The reply-draft route stores the draft it opens the same way, so the
// image proxy, which fetches only references in a message's stored body, can serve that draft's
// images in the composer.
import { query } from './db.js';
import { sanitizeEmail } from './emailSanitizer.js';
import { snippetFromBody } from './messageParser.js';
import { settleCids } from '../utils/cidRefs.js';

// Strip NUL bytes from strings before DB writes. PostgreSQL UTF-8 text columns
// reject 0x00, and malformed MIME bodies can contain embedded NUL characters.
export function sanitizeDbText(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/\0/g, '');
}

// fetchMessageBody's result stored for message `id`; returns the sanitized HTML (without the
// settled marker) and text as stored.
export async function storeFetchedBody(id, { html, text, attachments, cidsComplete }) {
  const sanitized = html ? sanitizeDbText(sanitizeEmail(html)) : null;
  // Stored settled when its cid: references can never resolve (utils/cidRefs.js, #595).
  const safeHtml = sanitized && settleCids(sanitized, cidsComplete);
  const safeText = sanitizeDbText(text);
  const snip = sanitizeDbText(snippetFromBody(safeText, sanitized || html));

  // Only cache when we actually got body content — don't overwrite a prior
  // successful cache with null if a transient IMAP fetch returns nothing.
  if (safeHtml || text || (attachments && attachments.length > 0)) {
    await query(
      `UPDATE messages
       SET body_html = $1, body_text = $2, attachments = $3,
           snippet = CASE WHEN $5 != '' THEN $5 ELSE snippet END
       WHERE id = $4`,
      [safeHtml, safeText, JSON.stringify(attachments || []), id, snip]
    );
  }
  return { sanitized, safeText };
}
