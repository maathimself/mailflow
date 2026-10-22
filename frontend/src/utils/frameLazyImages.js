// Images further down an email load as the reader nears them, not all at once. In the email frame
// `loading="lazy"` does nothing (browsers disable it where scripts are off, and the frame runs
// none), so a newsletter's every image was fetched the moment it opened: on a phone, its first
// screen waited behind images the reader might never scroll to (a 26-image newsletter: first
// screen 4.9 s, all images 7 s, on a slow 4G connection).
//
// So MailFlow does it from its own page. The frame's HTML (utils/emailFrameDoc.js) carries the
// image proxy's images after the first few with their address moved aside (data-mf-src); the page
// watches where they are against the reader's own viewport, and puts the address back when one
// comes within a screen or two of view.
// Only the proxy's images: inline (data:) images are in the HTML already, and with remote images
// blocked there is nothing to fetch.

// The first few load at once: they are most likely on the first screen.
export const EAGER_IMAGES = 4;
const PROXY_SRC = /^\s*(?:https?:\/\/[^/"'\s]+)?\/api\/mail\/messages\/[0-9a-f-]{36}\/image\?/i;
// First what is on screen, near enough; once that has loaded, a screen or two further.
const FIRST_SCREEN_AHEAD = 200;
const LOAD_AHEAD = 1500;
const FIRST_SCREEN_WAIT_MS = 1500;

// `html` with the proxied images after the first EAGER_IMAGES holding their address aside.
export function deferProxiedImages(html) {
  let seen = 0;
  return html.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = /\ssrc=(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    if (!src || !PROXY_SRC.test(src[1] ?? src[2])) return tag;
    seen += 1;
    if (seen <= EAGER_IMAGES) return tag;
    return tag.replace(/\ssrc=/i, ' data-mf-src=').replace(/\ssrcset=/i, ' data-mf-srcset=');
  });
}

export const isDeferredImage = (img) => img.hasAttribute('data-mf-src') || img.hasAttribute('data-mf-srcset');

function loadImage(img) {
  const srcset = img.getAttribute('data-mf-srcset');
  const src = img.getAttribute('data-mf-src');
  img.removeAttribute('data-mf-srcset');
  img.removeAttribute('data-mf-src');
  if (srcset !== null) img.setAttribute('srcset', srcset);
  if (src !== null) img.setAttribute('src', src);
}

// Starts watching `doc`'s held-back images. Each loads when it comes within `margin` px of the
// reader's viewport; until the first screen's images have loaded (or FIRST_SCREEN_WAIT_MS has
// passed), only within FIRST_SCREEN_AHEAD, so on a slow connection they have it to themselves. Measured by hand, once a frame at most, on any scroll in the page, a resize,
// or the email's layout changing: an IntersectionObserver ignores its margin for elements inside a
// frame in Chromium, Firefox and WebKit alike, so images loaded only once on screen, visibly late.
// One the email gives no height keeps a provisional one until it loads: collapsed to nothing,
// they would all sit within reach of the first screen and load together.
// Returns the cleanup, which stops watching (for an email being left: nothing more to fetch).
export function loadImagesNearView(doc, { margin = LOAD_AHEAD } = {}) {
  const pending = new Set(doc.querySelectorAll('img[data-mf-src], img[data-mf-srcset]'));
  const frame = doc.defaultView?.frameElement;
  const win = frame?.ownerDocument?.defaultView;
  if (!pending.size) return () => {};
  if (!frame || !win) {
    pending.forEach(loadImage);
    return () => {};
  }
  for (const img of pending) {
    if (img.getAttribute('height')) continue;
    const width = Number.parseFloat(img.getAttribute('width')) || 300;
    img.style.setProperty('min-height', `${Math.round(width / 2)}px`);
    const release = () => img.style.removeProperty('min-height');
    img.addEventListener('load', release, { once: true });
    img.addEventListener('error', release, { once: true });
  }

  let queued = 0;
  let stopped = false;
  let ahead = Math.min(FIRST_SCREEN_AHEAD, Number(margin) || 0);
  let widened = false;
  const widen = () => {
    if (widened || stopped) return;
    widened = true;
    ahead = Number(margin) || 0;
    schedule();
  };
  const check = () => {
    queued = 0;
    if (stopped) return;
    const top = frame.getBoundingClientRect().top;
    const height = win.innerHeight;
    for (const img of pending) {
      const r = img.getBoundingClientRect(); // within the frame, which never scrolls itself
      if (top + r.bottom >= -ahead && top + r.top <= height + ahead) {
        pending.delete(img);
        loadImage(img);
      }
    }
    if (!pending.size) stop();
  };
  const schedule = () => { if (!queued && !stopped) queued = win.requestAnimationFrame(check); };
  const resized = new win.ResizeObserver(schedule);
  resized.observe(doc.body || doc.documentElement);
  win.document.addEventListener('scroll', schedule, { capture: true, passive: true });
  win.addEventListener('resize', schedule, { passive: true });
  function stop() {
    if (stopped) return;
    stopped = true;
    if (queued) win.cancelAnimationFrame(queued);
    resized.disconnect();
    win.document.removeEventListener('scroll', schedule, { capture: true });
    win.removeEventListener('resize', schedule);
  }
  // Widen once what the first look started has settled, or after a while regardless.
  const widenTimer = win.setTimeout(widen, FIRST_SCREEN_WAIT_MS);
  win.requestAnimationFrame(() => win.requestAnimationFrame(() => {
    const started = [...doc.images].filter(img => !isDeferredImage(img) && img.getAttribute('src'));
    const unsettled = started.filter(img => !img.complete);
    if (!unsettled.length) { widen(); return; }
    let left = unsettled.length;
    const settled = () => { left -= 1; if (left === 0) widen(); };
    unsettled.forEach(img => {
      img.addEventListener('load', settled, { once: true });
      img.addEventListener('error', settled, { once: true });
    });
  }));
  schedule();
  return () => { win.clearTimeout(widenTimer); stop(); };
}
