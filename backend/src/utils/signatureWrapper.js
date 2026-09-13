// Class that marks the signature wrapper in outgoing and draft HTML. sanitizeEmail keeps
// `class` (unlike data-* attributes), so the marker survives a draft being re-fetched from
// IMAP and lets the composer split the signature back out when a draft is reopened (#432).
export const SIGNATURE_CLASS = 'mailexpert-signature';

// Wrap an already-sanitized signature for the HTML part. Shared by the draft and send
// routes so both write the exact shape frontend/src/utils/draftSignature.js looks for.
export function wrapSignatureHtml(signatureHtml) {
  return `<div class="${SIGNATURE_CLASS}" style="margin-top:16px;color:#555;font-size:13px">${signatureHtml}</div>`;
}
