import { useEffect, useLayoutEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { frameListenersRun, returnFocusFromFrame } from '../utils/frameFocus.js';
import { measureContentHeight, createHeightController, forceEagerImages, pinFrameRoot, createScrollExpander } from '../utils/emailFrameHeight.js';
import { forwardIframeKeydown } from '../utils/iframeKeys.js';
import { buildFrameDoc, DARK_DEFAULTS, SCALE_WRAPPER } from '../utils/emailFrameDoc.js';
import { applyDarkBody, restoreBody } from '../utils/darkBody.js';

// The theme's colors for a body shown dark (#228). They come from CSS variables that an admin's
// custom CSS can redefine, and they are written into the frame's stylesheet, so only a plain
// color value is taken; anything else falls back to the default dark theme's.
const COLOR_VALUE = /^(#[0-9a-f]{3,8}|rgba?\(\s*[\d.]+%?\s*,\s*[\d.]+%?\s*,\s*[\d.]+%?\s*(,\s*[\d.]+%?\s*)?\))$/i;
// The background the body actually shows, once its CSS applied: the sender's own when their dark
// design sets one. A computed color is always rgb()/rgba(), so it is safe to hand to a style.
export function frameSurface(doc) {
  try {
    const shown = (el) => {
      const color = el && doc.defaultView.getComputedStyle(el).backgroundColor;
      return color && color !== 'transparent' && !/^rgba\(.*,\s*0\)$/.test(color) ? color : null;
    };
    return shown(doc.body) || shown(doc.documentElement);
  } catch { return null; }
}

function darkPalette() {
  const read = (name, fallback) => {
    try {
      const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return COLOR_VALUE.test(value) ? value : fallback;
    } catch { return fallback; }
  };
  return {
    background: read('--bg-primary', DARK_DEFAULTS.background),
    text: read('--text-primary', DARK_DEFAULTS.text),
    link: read('--accent', DARK_DEFAULTS.link),
    muted: read('--text-secondary', DARK_DEFAULTS.muted),
    border: read('--border', DARK_DEFAULTS.border),
  };
}

// The email body, rendered in its own sandboxed frame.
//
// Extracted from MessagePane so a conversation view can mount one per expanded message
// (#316). Only expanded messages render a body; a collapsed message is a header and costs
// nothing, which is what keeps a long thread affordable when each body is a whole document.
//
// The frame node is forwarded rather than owned. MessagePane reaches into it for five
// separate things (selection, find-in-message, the context menu, positioning, resetting
// height between messages) and forwarding leaves every one of those untouched.
//
// The experimental div renderer (VITE_EMAIL_DIV_RENDER) is deliberately NOT here: it is off
// by default and untested, and moving it would double the size of this change.
function MessageBodyView({ body, messageId, emailScaleRef, hasNativeContextTarget, onContextMenu, iframeRef, dark = false, onDarkResult }) {
  const { t } = useTranslation();
  // Holds the ResizeObserver watching the frame's document, so the effect can disconnect the
  // previous one before observing a new document.
  const roRef = useRef(null);
  // Dark email bodies (#228). The frame always renders the email as sent; when `dark` asks for it,
  // utils/darkBody.js then shows it dark in place, or leaves it as sent when that would make text
  // unreadable. onDarkResult tells the card around the frame which happened and what background
  // the body shows, so the card matches it. Refs, so neither a new callback nor a toggle re-runs
  // the frame's setup: a toggle switches the loaded document instead of reloading it.
  const palette = darkPalette();
  const darkRef = useRef(dark);
  const paletteRef = useRef(palette);
  const onDarkResultRef = useRef(onDarkResult);
  // A layout effect declared before the others, so it has run first on every commit.
  useLayoutEffect(() => {
    darkRef.current = dark;
    paletteRef.current = palette;
    onDarkResultRef.current = onDarkResult;
  });
  const shownDocRef = useRef(null);

  function showDarkOrNot(doc) {
    let outcome = 'light';
    if (darkRef.current) {
      try {
        outcome = applyDarkBody(doc, { palette: paletteRef.current }).outcome;
      } catch {
        // Never let showing it dark break showing it at all.
        restoreBody(doc);
      }
    } else {
      restoreBody(doc);
    }
    // `requested` tells a refusal (asked for dark, left as sent) from simply not being asked.
    onDarkResultRef.current?.({ outcome, requested: darkRef.current, surface: outcome === 'light' ? null : frameSurface(doc) });
  }

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe || !body?.html) return;

    let rafId;
    let pollId = null;
    const heights = createHeightController();
    let initialisedDoc = null;
    let contextMenuDoc = null;
    let iframeContextMenuHandler = null;
    let clickDoc = null;
    let iframeClickHandler = null;
    let keyDoc = null;
    let iframeKeyHandler = null;
    let focusReturn = null;

    const setHeight = () => {
      const doc = iframe.contentDocument;
      if (!doc) return;
      const b = doc.body;
      const wrapper = doc.getElementById('mf-scale-wrapper');
      // documentElement is deliberately NOT measured: its scrollHeight is floored by
      // the frame's own viewport, so once the frame is N tall every reading is >= N
      // and an over-estimate can never be walked back. That floor, not the guard that
      // used to sit below it, is what left whitespace under short emails.
      const h = measureContentHeight({
        wrapperOffsetHeight: wrapper ? wrapper.offsetHeight : 0,
        wrapperOffsetTop:    wrapper ? wrapper.offsetTop    : 0,
        bodyScrollHeight:    b ? b.scrollHeight : 0,
        bodyOffsetHeight:    b ? b.offsetHeight : 0,
      });
      // Scale visual height to match the proportional scale applied to the
      // email wrapper (1 for normal emails, <1 for wide fixed-layout emails).
      // offsetHeight above is untransformed, so the factor applies exactly once.
      const next = heights.next(h, emailScaleRef.current);
      if (next !== null) iframe.style.height = next + 'px';
    };

    const onLoaded = () => {
      const doc = iframe.contentDocument;
      // Only ever initialise against OUR document. A freshly mounted frame exposes an
      // about:blank whose readyState is already 'complete', and a frame whose srcDoc has
      // just changed still exposes the PREVIOUS email until the swap lands. Either way the
      // readyState fast path further down can fire against a document that is not this
      // email, measuring it and binding a ResizeObserver to it. #mf-scale-wrapper is only
      // present in a document we rendered, which makes it a reliable marker.
      if (!doc || !doc.getElementById(SCALE_WRAPPER)) return;
      // Guard the fast path against re-running on a document already wired up. This is
      // per effect run, so a genuine re-run (changed deps) still re-attaches everything
      // the cleanup tore down.
      if (doc === initialisedDoc) return;
      initialisedDoc = doc;

      emailScaleRef.current = 1; // reset for each new email

      // Start every image fetching now, rather than letting the browser defer them.
      //
      // Lazy loading is gated on the scroll viewport, and for an iframe that viewport is
      // the frame's own box, which starts at 300px. Images below that never fetch, so they
      // measure as zero height, so the frame is sized short, which brings the next image
      // into range, which fetches, which grows the content, which resizes the frame again.
      // Every step of that staircase costs a network round trip, and a marketing email with
      // nine stacked images renders in visible instalments. Looking at it mid-staircase is
      // the "half loaded" email; it only appears fixed on a second visit because the images
      // are cached by then.
      //
      // Nothing is lost by loading eagerly: the frame has no internal scrolling and is
      // sized to its full content, so every image ends up on screen regardless.
      //
      // Done against the DOM rather than by rewriting the srcDoc HTML so there is no chance
      // of matching the attribute inside text content. Flipping here, before the load
      // handlers further down are attached, is safe because everything between is
      // synchronous: a fetch cannot deliver its load event until this function yields, by
      // which point the handlers exist. The ResizeObserver on the body is the backstop
      // regardless.
      forceEagerImages(doc);

      pinFrameRoot(doc);
      const b = doc.body;
      const h = doc.documentElement;

      // Some marketing emails (e.g. Avis) use class-based !important rules that
      // lock layout to a fixed pixel width and cannot be overridden by our injected
      // CSS. Measure the rendered content width and, if it exceeds the iframe,
      // scale the entire wrapper div down proportionally so all content is visible.
      const iframeW = iframe.offsetWidth;
      if (iframeW > 0) {
        // iOS Safari clamps scrollWidth to the iframe viewport when overflow:hidden
        // is set on html/body, so wide fixed-layout emails are never detected.
        // Temporarily expose overflow-x inline (beating the !important stylesheet
        // rule) to let scrollWidth reflect the true content width, then restore.
        // Note: overflow-x:visible is coerced to auto when overflow-y is non-visible —
        // that's fine; auto still returns the real scrollable content width.
        if (b) b.style.setProperty('overflow-x', 'visible', 'important');
        if (h) h.style.setProperty('overflow-x', 'visible', 'important');
        const contentW = Math.max(
          h ? h.scrollWidth : 0,
          b ? b.scrollWidth : 0,
        );
        if (b) b.style.removeProperty('overflow-x');
        if (h) h.style.removeProperty('overflow-x');

        const wrapper = doc.getElementById('mf-scale-wrapper');
        if (contentW > iframeW + 2) { // +2 absorbs sub-pixel rounding
          const scale = iframeW / contentW;
          emailScaleRef.current = scale;
          if (wrapper) {
            wrapper.style.transform       = `scale(${scale})`;
            wrapper.style.transformOrigin = 'top left';
            // Lock the wrapper at its natural content width so the scale
            // maps exactly contentW → iframeW with no clipping.
            wrapper.style.width           = `${contentW}px`;
          }
        }
      }

      const expandScrollContainers = createScrollExpander(doc);
      expandScrollContainers();

      // Show it dark now, before the frame first paints: this runs in the animation frame after
      // the document is parsed, ahead of rendering, so the light version is never seen. After
      // the layout fixes above, so the measured text is the text as it will show.
      shownDocRef.current = doc;
      showDarkOrNot(doc);

      // Recalculate from scratch with the new scale. The controller deliberately does
      // not seed itself from the frame's current height, so this measurement is
      // authoritative even when it is SHORTER than what is currently applied. That is
      // what clears leftover whitespace when the previous email was taller.
      heights.reset();
      setHeight();
      rafId = requestAnimationFrame(setHeight);

      // Intercept all link clicks so they always open in a real browser tab.
      // Without this, relative hrefs (e.g. href="/") resolve to the mailflow
      // origin via allow-same-origin and open a new mailflow tab instead of
      // the intended destination.  We read the raw attribute to bypass
      // browser resolution and only forward absolute http(s)/mailto links.
      // Tracked and removed like the contextmenu handler below — onLoaded can
      // re-run on the same document when the effect's callback deps change,
      // and an untracked listener stacks up, opening N duplicate tabs per click.
      if (clickDoc && iframeClickHandler) {
        clickDoc.removeEventListener('click', iframeClickHandler);
      }
      iframeClickHandler = (ev) => {
        const anchor = ev.target.closest('a[href]');
        if (!anchor) return;
        ev.preventDefault();
        let raw = anchor.getAttribute('href') || '';
        if (raw.startsWith('//')) raw = 'https:' + raw;
        if (/^https?:\/\//i.test(raw)) {
          window.open(raw, '_blank', 'noopener,noreferrer');
        } else if (/^mailto:/i.test(raw)) {
          window.open(raw, '_blank', 'noopener,noreferrer');
        }
      };
      clickDoc = doc;
      doc.addEventListener('click', iframeClickHandler);

      if (contextMenuDoc && iframeContextMenuHandler) {
        contextMenuDoc.removeEventListener('contextmenu', iframeContextMenuHandler);
      }
      iframeContextMenuHandler = (ev) => {
        if (hasNativeContextTarget(ev, doc)) return;
        ev.preventDefault();
        const rect = iframe.getBoundingClientRect();
        onContextMenu(rect.left + ev.clientX, rect.top + ev.clientY, {
          source: 'iframe',
          selectedText: doc.getSelection?.().toString() || '',
        });
      };
      contextMenuDoc = doc;
      doc.addEventListener('contextmenu', iframeContextMenuHandler);

      // Keyboard shortcuts after clicking into the body (#537): the frame's key presses never
      // reach the page's listener on their own. Tracked like the handlers above.
      if (keyDoc && iframeKeyHandler) {
        keyDoc.removeEventListener('keydown', iframeKeyHandler);
      }
      iframeKeyHandler = (ev) => { forwardIframeKeydown(ev, document); };
      keyDoc = doc;
      doc.addEventListener('keydown', iframeKeyHandler);
      // WebKit (Safari, every browser on iOS) runs none of these listeners inside a sandboxed frame
      // without scripts. There the page hands focus back to itself after a click on the email, so
      // the shortcuts still work (utils/frameFocus.js); the right-click menu on the email is
      // Safari's own, which no page can change from outside the frame.
      if (!focusReturn && !frameListenersRun(doc)) focusReturn = returnFocusFromFrame(iframe);

      // Re-measure after each lazy-loaded image settles; also re-expand any
      // scroll containers whose content has grown due to the newly loaded image.
      doc.querySelectorAll('img').forEach(img => {
        if (!img.complete) {
          img.addEventListener('load', () => { expandScrollContainers(); requestAnimationFrame(setHeight); }, { once: true });
          img.addEventListener('error', () => requestAnimationFrame(setHeight), { once: true });
        }
      });

      // Watch for content that reflows after load (web fonts, dynamic content).
      // Shrinking is allowed here: content height cannot depend on frame height,
      // because html/body are pinned to height:auto above and media queries key off
      // width. createHeightController still carries a tolerance band plus an
      // oscillation freeze in case some email defeats that reasoning.
      const root = doc.body || doc.documentElement;
      if (window.ResizeObserver && root) {
        // Disconnect first: onLoaded can legitimately run more than once per effect
        // (stale document, then the real one), and overwriting the ref without this
        // leaves the previous observer running against the old document forever.
        if (roRef.current) roRef.current.disconnect();
        roRef.current = new ResizeObserver(() => requestAnimationFrame(setHeight));
        roRef.current.observe(root);
      }
    };

    // 'load' is kept, but it CANNOT be the only trigger. It waits for every subresource,
    // so a single image that never settles (a dead tracking pixel, a blocked host, a host
    // that accepts the connection and never answers) leaves the document parked at
    // readyState 'interactive' forever. load never fires, none of the setup above ever
    // runs, and the frame sits at its initial 300px with the email clipped inside it. One
    // unreachable image was enough to break rendering of the whole message.
    //
    // Not { once: true } either: a frame fires 'load' for the about:blank it starts life
    // with, and a once-listener is spent on that even though onLoaded correctly declines
    // to initialise against a document that is not ours.
    iframe.addEventListener('load', onLoaded);

    // Everything onLoaded does needs only a parsed DOM, never a finished one, so drive it
    // from the parsed state and let the image handlers and the ResizeObserver grow the
    // frame as pictures arrive. Polling by frame rather than listening for
    // DOMContentLoaded because the document to listen on does not exist yet at this point:
    // the frame is still showing about:blank and swaps in the real one later. onLoaded is
    // idempotent per document, so the repeated calls are free and stop as soon as one
    // succeeds.
    let pollFrames = 0;
    const MAX_POLL_FRAMES = 300; // ~5s at 60fps; srcDoc parses far sooner
    const pollUntilParsed = () => {
      pollId = null;
      onLoaded();
      if (initialisedDoc || pollFrames++ >= MAX_POLL_FRAMES) return;
      pollId = requestAnimationFrame(pollUntilParsed);
    };
    pollUntilParsed();

    return () => {
      cancelAnimationFrame(rafId);
      if (pollId) cancelAnimationFrame(pollId);
      if (roRef.current) { roRef.current.disconnect(); roRef.current = null; }
      if (contextMenuDoc && iframeContextMenuHandler) {
        contextMenuDoc.removeEventListener('contextmenu', iframeContextMenuHandler);
      }
      if (clickDoc && iframeClickHandler) {
        clickDoc.removeEventListener('click', iframeClickHandler);
      }
      if (keyDoc && iframeKeyHandler) {
        keyDoc.removeEventListener('keydown', iframeKeyHandler);
      }
      focusReturn?.();
      iframe.removeEventListener('load', onLoaded);
      emailScaleRef.current = 1;
    };
  }, [body?.html, messageId, hasNativeContextTarget, onContextMenu, emailScaleRef, iframeRef]);

  // The toggle: switch the document already shown, without reloading it, before the browser
  // paints. Its layout can change with a sender's dark design; the ResizeObserver on its body
  // resizes the frame.
  useLayoutEffect(() => {
    const doc = shownDocRef.current;
    if (doc && doc === iframeRef.current?.contentDocument) showDarkOrNot(doc);
  }, [dark, iframeRef]);

  // The frame's document (utils/emailFrameDoc.js): the email as sent, carrying the theme's dark
  // colors and the sender's own dark design switched off until showDarkOrNot uses them.
  const srcDoc = buildFrameDoc({ html: body.html, palette, darkCss: body.darkCss, remoteImagesBlocked: body.remoteImagesBlocked, remoteImagesProxied: body.remoteImagesProxied });

  return (
    <iframe
      ref={iframeRef}
      srcDoc={srcDoc}
      scrolling="no"
      style={{ width: '1px', minWidth: '100%', border: 'none', display: 'block', height: '300px' }}
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      title={t('message.emailFrameTitle')}
    />
  );
}

export default MessageBodyView;
