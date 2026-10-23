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
// settled marker) and text as stored, and whether it was stored. With `over` (a messages row as
// read before the fetch), it is stored only while the row still holds that body at that UID: a
// repair fetch that lands late must not replace a body stored since, such as another message's
// after its UID was reused (#640).
export async function storeFetchedBody(id, { html, text, attachments, cidsComplete }, { over } = {}) {
  const sanitized = html ? sanitizeDbText(sanitizeEmail(html)) : null;
  // Marked when fetched completely, so it is not fetched again for its images (utils/cidRefs.js).
  // Nothing left after sanitizing (whitespace, a lone <script>) is stored as no HTML at all.
  const safeHtml = sanitized ? settleCids(sanitized, cidsComplete) : null;
  const safeText = sanitizeDbText(text);
  const snip = sanitizeDbText(snippetFromBody(safeText, sanitized || html));

  // Only cache when we actually got body content — don't overwrite a prior
  // successful cache with null if a transient IMAP fetch returns nothing.
  let stored = false;
  if (safeHtml || text || (attachments && attachments.length > 0)) {
    const params = [safeHtml, safeText, JSON.stringify(attachments || []), id, snip];
    const guard = over
      ? ` AND body_html IS NOT DISTINCT FROM $6 AND body_text IS NOT DISTINCT FROM $7 AND uid = $8 AND folder = $9`
      : '';
    if (over) params.push(over.body_html ?? null, over.body_text ?? null, over.uid, over.folder);
    const result = await query(
      `UPDATE messages
       SET body_html = $1, body_text = $2, attachments = $3,
           snippet = CASE WHEN $5 != '' THEN $5 ELSE snippet END
       WHERE id = $4${guard}`,
      params
    );
    stored = !over || Boolean(result?.rowCount);
  }
  return { sanitized, safeText, stored };
}
