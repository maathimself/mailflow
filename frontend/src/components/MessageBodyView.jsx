import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { measureContentHeight, createHeightController, forceEagerImages } from '../utils/emailFrameHeight.js';
import { forwardIframeKeydown } from '../utils/iframeKeys.js';

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
function MessageBodyView({ body, messageId, emailScaleRef, hasNativeContextTarget, onContextMenu, iframeRef }) {
  const { t } = useTranslation();
  // Holds the ResizeObserver watching the frame's document, so the effect can disconnect the
  // previous one before observing a new document.
  const roRef = useRef(null);

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
      if (!doc || !doc.getElementById('mf-scale-wrapper')) return;
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

      // Some marketing emails have inline styles on their <body> tag (e.g. overflow:auto,
      // height:100%) that the HTML parser merges into the iframe's outer <body>.  Our
      // injected <style> with !important can't win against inline !important rules.
      // Setting the properties via JS style.setProperty(...,'important') writes them as
      // inline !important, which always beats any same-property inline value from the email.
      const b = doc.body;
      const h = doc.documentElement;
      if (b) {
        b.style.setProperty('height', 'auto', 'important');
        b.style.setProperty('min-height', '0', 'important');
        b.style.setProperty('overflow-y', 'hidden', 'important');
      }
      if (h) {
        h.style.setProperty('height', 'auto', 'important');
        h.style.setProperty('min-height', '0', 'important');
        h.style.setProperty('overflow-y', 'hidden', 'important');
      }

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

      // Expand any nested scroll containers so their full content is visible
      // without internal scrolling. Marketing emails sometimes apply overflow:auto
      // plus a fixed height to inner divs/tds, which makes iOS scroll that element
      // instead of the outer pane container — leaving the sender card pinned like a
      // sticky header.
      //
      // Process in REVERSE document order (deepest elements first) so that when we
      // expand an inner scroll container, the outer container's scrollHeight already
      // reflects the expanded child when we evaluate it — preventing missed outer
      // containers in a single pass.
      //
      // expandedEls tracks which elements we've already expanded so that subsequent
      // calls from image load handlers can re-check and grow them as lazy images add
      // height (an element that was 1 000 px after the first pass may be 3 000 px
      // once all images are loaded).
      const expandedEls = new Set();
      const dv = doc.defaultView;
      const expandScrollContainers = () => {
        if (!dv) return;
        Array.from(doc.querySelectorAll('*')).reverse().forEach(el => {
          const cs = dv.getComputedStyle(el);
          const oy = cs.overflowY;
          const isScrollContainer = (oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 2;
          const grewAfterExpansion = expandedEls.has(el) && el.scrollHeight > el.clientHeight + 2;
          if (isScrollContainer || grewAfterExpansion) {
            expandedEls.add(el);
            el.style.setProperty('overflow-y', 'hidden', 'important');
            el.style.setProperty('max-height', 'none', 'important');
            el.style.setProperty('height', el.scrollHeight + 'px', 'important');
          }
        });
      };
      expandScrollContainers();

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
      iframe.removeEventListener('load', onLoaded);
      emailScaleRef.current = 1;
    };
  }, [body?.html, messageId, hasNativeContextTarget, onContextMenu, emailScaleRef, iframeRef]);

  return (
    <iframe
      ref={iframeRef}
      srcDoc={`<!DOCTYPE html><html><head><meta charset="utf-8">
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <meta name="color-scheme" content="only light">
      <meta http-equiv="Content-Security-Policy" content="script-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; style-src 'unsafe-inline';">
      <base target="_blank">
    </head><body><div id="mf-scale-wrapper">${
      body.html.replace(/<a(\s)/gi, '<a rel="noopener noreferrer"$1')
    }</div><style>
        /* Injected AFTER email HTML so our rules win the source-order tiebreak
           for same-specificity !important declarations inside the email's own
           <style> blocks (which land in <body> after the email HTML). */
        html, body { height: auto !important; min-height: 0 !important; overflow: hidden !important; }
        body { margin: 0 !important; padding: 0 !important;
               background-color: #ffffff !important; color-scheme: light;
               font-family: -apple-system, Arial, sans-serif;
               font-size: 14px; line-height: 1.6; color: #1a1a1a;
               word-wrap: break-word; overflow-wrap: break-word; }
        img { max-width: 100% !important; height: auto !important; }
        /* Force top-level wrapper tables to fill the viewport. Selectors cover
           both the legacy body > table pattern and the mf-scale-wrapper layer. */
        body > table, body > center > table,
        body > div > table, body > center > div > table,
        #mf-scale-wrapper > table, #mf-scale-wrapper > center > table,
        #mf-scale-wrapper > div > table, #mf-scale-wrapper > center > div > table {
          width: 100% !important;
        }
        /* Reset min-width on cells only — not on table elements, because fluid
           grid systems (e.g. Oracle Eloqua "tolkien") set min-width on inline-table
           column elements as a layout fallback when their calc() width resolves to 0. */
        td, th { min-width: 0 !important; }
        td { word-break: break-word; }
        th { overflow-wrap: normal; word-break: normal; }
        a { color: #6366f1; }
        pre, code { overflow-x: auto; white-space: pre-wrap; word-break: break-all; }
        blockquote { border-left: 3px solid #ddd; margin: 0; padding-left: 12px; color: #555; }
      </style></body></html>`}
      scrolling="no"
      style={{ width: '1px', minWidth: '100%', border: 'none', display: 'block', height: '300px' }}
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      title={t('message.emailFrameTitle')}
    />
  );
}

export default MessageBodyView;
