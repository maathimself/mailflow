// Splits the signature back out of a stored draft so reopening it does not stack another
// copy on top (#432). The backend writes the signature into the draft body inside the
// wrapper from backend/src/utils/signatureWrapper.js; the composer keeps the signature in its
// own editor, so on reopen the body must go into the body editor without it.

const SIGNATURE_CLASS = 'mailexpert-signature';
// Wrapper style written before the class marker existed. Matched exactly (ignoring
// whitespace and a trailing semicolon) and only on a div without a class.
const LEGACY_SIGNATURE_STYLE = 'margin-top:16px;color:#555;font-size:13px';

// Plain-text signature delimiter written by the draft and send routes.
const TEXT_DELIMITER = '\n\n-- \n';
// Quote headers appended after the signature by composeFromMessage.js (reply and forward).
const TEXT_QUOTE_HEADER_RE = /\n\n(?:---\nOn [^\n]* wrote:\n|---------- Forwarded message ----------\n)/;

const normalizeStyle = (style) => (style || '').replace(/\s+/g, '').replace(/;$/, '').toLowerCase();

const isMarkedWrapper = (el) => el.tagName === 'DIV' && el.classList.contains(SIGNATURE_CLASS);
const isLegacyWrapper = (el) => el.tagName === 'DIV'
  && !el.getAttribute('class')
  && normalizeStyle(el.getAttribute('style')) === LEGACY_SIGNATURE_STYLE;

// Returns { bodyHtml, signatureHtml }. Only a top-level wrapper counts, so a signature inside
// a quoted MailExpert message is left alone. When several wrappers exist (a draft duplicated
// before this fix) only the last one is taken; earlier copies stay in the body.
// `document` is injectable so the helper runs under node --test with jsdom.
export function splitDraftSignature(html, { document = globalThis.document } = {}) {
  const unchanged = { bodyHtml: html, signatureHtml: null };
  if (!html || !document) return unchanged;

  // A <template> keeps <style> and other head-only elements in place, unlike DOMParser.
  const template = document.createElement('template');
  template.innerHTML = html;
  const children = Array.from(template.content.children);
  const wrapper = children.findLast(isMarkedWrapper) || children.findLast(isLegacyWrapper);
  if (!wrapper) return unchanged;

  const signatureHtml = wrapper.innerHTML;
  wrapper.remove();
  return { bodyHtml: template.innerHTML, signatureHtml };
}

// Returns { body, signature, quote } for the text part, which the draft route stores as
// body + "\n\n-- \n" + signature + quote. The quote starts at the first reply or forward header
// and is returned separately: if it stayed in the body, the next save would append the
// signature after it, and a delimiter after a quote cannot be told apart from a forwarded
// message's own signature. A delimiter inside the quote is therefore never taken.
export function splitDraftSignatureText(text) {
  if (!text) return { body: text, signature: null, quote: '' };

  const quoteMatch = TEXT_QUOTE_HEADER_RE.exec(text);
  const quoteStart = quoteMatch ? quoteMatch.index : text.length;
  const head = text.slice(0, quoteStart);
  const quote = text.slice(quoteStart);
  const delimiterAt = head.lastIndexOf(TEXT_DELIMITER);
  if (delimiterAt === -1) return { body: head, signature: null, quote };

  return {
    body: head.slice(0, delimiterAt),
    signature: head.slice(delimiterAt + TEXT_DELIMITER.length),
    quote,
  };
}

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Builds the body fields of composeData for reopening a draft from getMessageBody's response.
// draftSignature is present only when a signature was found, so the composer falls back to
// the account/alias signature otherwise.
export function draftComposeFields(bodyData, { plaintext = false, document = globalThis.document } = {}) {
  const html = bodyData?.html || '';
  const text = bodyData?.text || '';

  if (html && !(plaintext && text)) {
    const { bodyHtml, signatureHtml } = splitDraftSignature(html, { document });
    return { body: bodyHtml, bodyIsHtml: true, ...(signatureHtml != null ? { draftSignature: signatureHtml } : {}) };
  }

  const { body, signature, quote } = splitDraftSignatureText(text);
  return {
    body,
    bodyIsHtml: false,
    ...(quote ? { quotedBody: quote } : {}),
    // The composer's signature editor takes HTML; keep line breaks readable in both modes.
    ...(signature != null ? { draftSignature: signature.split('\n').map(escapeHtml).join('<br>\n') } : {}),
  };
}
