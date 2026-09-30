// Attachment filename sanitization + Content-Disposition header construction.
//
// `safeFilename` cleans a filename for display/storage: it strips path separators, control chars,
// and Unicode bidi-override chars (which could spoof a displayed extension, e.g. U+202E reversing
// the name) — but deliberately KEEPS Unicode. That's correct for a ZIP entry name (UTF-8).
//
// An HTTP header is NOT UTF-8, though: Node's res.setHeader rejects any value containing a code
// point above U+00FF (ERR_INVALID_CHAR), so a non-ASCII filename in a `Content-Disposition` value
// throws. `attachmentDisposition` therefore carries the real (possibly Unicode) name only in the
// RFC 5987 `filename*=UTF-8''…` parameter, and reduces the quoted `filename="…"` fallback to
// printable ASCII (also neutralizing " and \, which would otherwise break the quoted-string). See #367.

// Cut a name to at most `max` UTF-16 units without splitting a surrogate pair. A plain .slice()
// can keep only the first half of an emoji, and that lone surrogate makes encodeURIComponent
// (rfc5987 below) throw URIError, so the download fails with a 500.
export function truncateFilename(name, max) {
  return name.slice(0, name.codePointAt(max - 1) > 0xffff ? max - 1 : max);
}

export function safeFilename(name) {
  if (!name) return 'attachment';
  const cleaned = String(name)
    .toWellFormed()
    .replace(/[/\\]/g, '_')
    // eslint-disable-next-line no-control-regex -- intentionally stripping control characters (U+0000–U+001F, U+007F)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    // Bidi overrides/isolates + RLM/ALM (U+202A–U+202E, U+2066–U+2069, U+200F, U+061C).
    .replace(/[\u202a-\u202e\u2066-\u2069\u200f\u061c]/g, '')
    .trim();
  return truncateFilename(cleaned, 255) || 'attachment';
}

// Percent-encode a UTF-8 string as an RFC 5987 ext-value (for `filename*=UTF-8''…`). encodeURIComponent
// handles almost all of it, but leaves ' ( ) * unencoded — and those are NOT RFC 5987 attr-chars —
// so encode them too, matching encodeURIComponent's uppercase %XX form.
function rfc5987(str) {
  return encodeURIComponent(str).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

// A `Content-Disposition` value for an attachment download that always survives res.setHeader:
// an ASCII-only quoted fallback plus the RFC 5987 `filename*` carrying the true name.
export function attachmentDisposition(rawName) {
  const safe = safeFilename(rawName);
  const ascii = safe.replace(/[^\u0020-\u007e]/g, '_').replace(/["\\]/g, '_') || 'attachment';
  return `attachment; filename="${ascii}"; filename*=UTF-8''${rfc5987(safe)}`;
}
