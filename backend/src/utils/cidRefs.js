// Inline images (cid: references) and the cached message body (#595).
//
// The body route sends a cached body back to the mail server when it still holds cid:
// references: bodies cached before inline images were embedded as data: URIs need that repair.
// But some references never resolve (a Content-ID no MIME part has, or one left over the inline
// image repeat budget), and every view of such a message fetched the whole body from the server
// again. So a body fetched completely, all its images read, is stored with CIDS_SETTLED when
// references remain, and is not fetched again for them. A body whose image bytes did not arrive
// is stored without it and retried on the next view.

export const CIDS_SETTLED = '<!--mf-cids-settled-->';

// A cid: reference where a URL goes (src="cid:...", url(cid:...)), not the text "CID: 4521" in a
// support email, which used to send every view of it to the mail server too.
const CID_REFERENCE = /["'(]\s*cid:/i;

export const hasCidReference = (html) => typeof html === 'string' && CID_REFERENCE.test(html);

// Whether a cached body is worth fetching again for its inline images.
export const needsCidRefetch = (html) => hasCidReference(html) && !html.includes(CIDS_SETTLED);

// A freshly fetched body as it is stored: marked settled when the fetch was complete and
// references remain (fetchMessageBody's cidsComplete).
export function settleCids(html, complete) {
  if (!complete || !hasCidReference(html) || html.includes(CIDS_SETTLED)) return html;
  return `${html}${CIDS_SETTLED}`;
}

// The body as it leaves MailFlow: the marker is for the cache only.
export const withoutCidMarker = (html) => (typeof html === 'string' ? html.split(CIDS_SETTLED).join('') : html);
