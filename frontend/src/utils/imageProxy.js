// The image proxy (backend services/imageProxy.js): remote images in a body the reader may load
// arrive as proxy URLs that carry each original reference exactly as the email wrote it. The
// composer keeps them while it shows a quoted email or a reopened draft, so nothing loads from the
// sender, and turns them back where its HTML leaves for the server (ComposeModal's send and draft
// save): recipients cannot load MailFlow's proxy, and the original HTML comes back byte for byte.
//
// The format is the backend's imageProxyPath; the two must agree.
const PROXIED = /\/api\/mail\/messages\/[0-9a-f-]{36}\/image\?u=([A-Za-z0-9%._~-]*)/gi;

export function unproxyImages(html) {
  if (!html) return html;
  return html.replace(PROXIED, (match, encoded) => {
    try {
      return decodeURIComponent(encoded);
    } catch {
      return match;
    }
  });
}
