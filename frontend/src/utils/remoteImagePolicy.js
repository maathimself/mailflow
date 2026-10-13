// Remote images blocked, or loaded only through MailFlow's image proxy, enforced by the browser.
//
// When a body is served with remote images blocked (the body route's remoteImagesBlocked), the
// backend has already rewritten every remote image reference it recognizes (emailSanitizer.js
// blockRemoteImages). The document the body is shown in also forbids remote images, fonts and
// media in its Content-Security-Policy, so a reference no pattern recognized (a CSS escape, a
// syntax not foreseen) still loads nothing: no tracking pixel fires. Inline images arrive as
// data: URIs and still show.
export const BLOCKED_REMOTE_LOADS = "img-src data: blob:; font-src data:; media-src data: blob:;";

// When a body's allowed images come through the image proxy (remoteImagesProxied), they come from
// MailFlow itself ('self'); nothing loads straight from a sender's server. Remote fonts and media
// are not proxied and stay off.
export const PROXIED_REMOTE_LOADS = "img-src 'self' data: blob:; font-src data:; media-src data: blob:;";

// The directives to add to a document's CSP, after a directive ending in ';'.
export const remoteLoadsCsp = (blocked, proxied = false) =>
  (blocked ? ` ${BLOCKED_REMOTE_LOADS}` : proxied ? ` ${PROXIED_REMOTE_LOADS}` : '');
