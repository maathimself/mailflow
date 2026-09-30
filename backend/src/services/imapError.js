// Turning an imapflow error into something a log line can actually explain.
//
// Every rejected IMAP command throws the same Error('Command failed'), so err.message
// alone is worthless in a log: a connection limit, a permission denial and an unknown
// mailbox all read identically. The server almost always says why, and imapflow keeps
// that text on err.responseText, with a machine-readable code on err.serverResponseCode.
//
// Reported on #474, where a Yahoo account produced screens of bare "Command failed" and
// the reason was discarded at every log site, leaving nothing to diagnose from.
//
// Lives in its own module because both imapManager and folderStatus need it, and
// imapManager already imports folderStatus, so the other direction would be circular.

/**
 * @param err  an error from imapflow, or anything else thrown near it
 * @returns    a human-readable reason, prefixed with the server's response code when
 *             there is one, since that is the part worth matching on later
 */
export function extractImapError(err) {
  if (!err) return 'Unknown error';

  // A connect that fails on every address the host resolves to (IPv6 and IPv4 under
  // autoSelectFamily) rejects with an AggregateError whose message is empty; the reasons are
  // on .errors, one per address. Unwrapped, it read only "AggregateError" in the log and the
  // UI, with nothing to diagnose from (#510).
  if (Array.isArray(err.errors) && err.errors.length && err.name === 'AggregateError') {
    const reasons = [...new Set(err.errors.map(e => e?.message || e?.code).filter(Boolean))];
    if (reasons.length) return reasons.join('; ');
    if (err.code) return String(err.code);
  }
  const code = err.serverResponseCode ? `[${err.serverResponseCode}] ` : '';

  // The parsed response carries the server's TEXT attributes; imapflow joins them into
  // responseText, so either is the same sentence. Prefer whichever is present.
  if (err.response && typeof err.response === 'object') {
    const text = err.response.attributes?.find(a => a.type === 'TEXT')?.value;
    if (text) return `${code}${String(text).trim()}`;
  }
  if (err.responseText) return `${code}${String(err.responseText).trim()}`;
  if (err.response?.command) return `${code}${err.response.command}: ${err.message}`;

  return `${code}${err.serverResponse || err.message || String(err)}`;
}
