// Inline images (cid: references) and the cached message body (#595).
//
// The body route sends a cached body back to the mail server when it still holds cid:
// references: bodies cached before inline images were embedded as data: URIs need that repair.
// But some references never resolve (a Content-ID no MIME part has, or one left over the inline
// image repeat budget), and every view of such a message fetched the whole body from the server
// again. So a body fetched completely, all its images read, is stored with CIDS_SETTLED, and is
// not fetched again for references left in it. A body whose image bytes did not arrive is stored
// without it and retried on the next view.
//
// The marker also says which MailFlow fetched the body. Images an email uses in its own layout
// were shown as broken attachments in bodies fetched before it (#640), with or without a cid:
// reference left, so a body without it whose message has an image attachment is fetched once
// more (needsImageRefetch). Changing how bodies are fetched for images means a new marker.
import { rasterImageTypeOfName } from './inlineImages.js';

export const CIDS_SETTLED = '<!--mf-cids-settled:3-->';

// Markers from before the current one, stripped as the current one is. A body settled under one
// may hold references that resolve now (#640), so it is fetched once more.
const LEGACY_CIDS_SETTLED = ['<!--mf-cids-settled:2-->', '<!--mf-cids-settled-->'];

// A cid: reference where a URL goes (src="cid:...", url(cid:...)), not the text "CID: 4521" in a
// support email, which used to send every view of it to the mail server too.
const CID_REFERENCE = /["'(]\s*cid:/i;

export const hasCidReference = (html) => typeof html === 'string' && CID_REFERENCE.test(html);

// Whether a cached body is worth fetching again for its inline images.
export const needsCidRefetch = (html) => hasCidReference(html) && !html.includes(CIDS_SETTLED);

// An image in a message's stored attachment list: by its type, or by a raster image file name on
// a part sent as application/octet-stream.
const isImageAttachment = (att) => Boolean(att)
  && (/^image\//i.test(String(att.type || '')) || Boolean(rasterImageTypeOfName(att.filename)));

// Whether a cached HTML body was fetched before the current marker and its message has an image
// attachment, which the body may show now (#640). A body without one is served as stored, or
// every cached body would be fetched again once. That leaves two kinds of body unrepaired, though
// a fresh fetch now shows their images: an unnamed related image referenced only by its
// Content-Location was never listed, and an image/x-png or image/pjpeg table background was a
// related part, not an attachment, whose background the sanitizer dropped. An empty body cannot
// hold the marker, so it is never fetched again this way: that would be every view.
export const needsImageRefetch = (html, attachments) => typeof html === 'string' && html !== ''
  && !html.includes(CIDS_SETTLED)
  && Array.isArray(attachments) && attachments.some(isImageAttachment);

// A body settled under an earlier marker.
export const settledEarlier = (html) => typeof html === 'string'
  && LEGACY_CIDS_SETTLED.some(marker => html.includes(marker));

// A freshly fetched body as it is stored: marked when the fetch was complete
// (fetchMessageBody's cidsComplete).
export function settleCids(html, complete) {
  if (!complete || typeof html !== 'string' || !html || html.includes(CIDS_SETTLED)) return html;
  return `${withoutCidMarker(html)}${CIDS_SETTLED}`;
}

// The body as it leaves MailFlow: the marker is for the cache only.
export const withoutCidMarker = (html) => (typeof html === 'string'
  ? [CIDS_SETTLED, ...LEGACY_CIDS_SETTLED].reduce((out, marker) => out.split(marker).join(''), html)
  : html);
