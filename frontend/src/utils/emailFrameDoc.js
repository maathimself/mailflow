// The document an email body is rendered in: the sandboxed frame's srcDoc (MessageBodyView).
//
// A plain function so the dark-mode audit harness (scripts/dark-audit) renders exactly what the
// reader does, from the same code.
//
// The body always renders as sent first: forced light, as every body was before #228. Showing it
// dark happens afterwards, in place, by utils/darkBody.js, which needs the light rendering to
// measure first. For that the document carries two more style elements, switched off
// (media="not all") until used:
//   FRAME_STYLE.dark    the theme's colors, for an email shown with its sender's own dark design
//   FRAME_STYLE.sender  that dark design (the body route's darkCss), after MailFlow's styles so it
//                       wins where it sets something
// The light styles sit in their own element so they can be switched off in turn. Their content
// and position are unchanged: after the email's HTML, so they win the source-order tiebreak.

import { remoteLoadsCsp } from './remoteImagePolicy.js';
import { deferProxiedImages } from './frameLazyImages.js';

// The default dark theme's colors, for a palette value that is not a plain color.
export const DARK_DEFAULTS = { background: '#0f0f11', text: '#e8e8f0', link: '#8b7cf8', muted: '#9a9ab0', border: '#2a2a35' };

export const FRAME_STYLE = { light: 'mf-frame-light', dark: 'mf-frame-dark', sender: 'mf-sender-dark' };
export const SCALE_WRAPPER = 'mf-scale-wrapper';

// The sender's dark CSS, if it may be used. It comes from inside a style element, so it cannot
// close one; refuse it if it ever does.
export function usableDarkCss(darkCss) {
  return typeof darkCss === 'string' && !/<\/style/i.test(darkCss) ? darkCss : '';
}

// `remoteImagesBlocked`: the body was served with remote images blocked, so the frame forbids
// remote loads outright; `remoteImagesProxied`: its images come through MailFlow's image proxy, so
// the frame loads images from MailFlow alone (utils/remoteImagePolicy.js). `docKey` (digits) marks
// this document as the one its frame is waiting for (MessageBodyView): the previous email's is
// still there for a moment after it changes.
export function buildFrameDoc({ html, palette = DARK_DEFAULTS, darkCss = '', remoteImagesBlocked = false, remoteImagesProxied = false, docKey = '' }) {
  const css = usableDarkCss(darkCss);
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <meta name="color-scheme" content="only light">
      <meta http-equiv="Content-Security-Policy" content="script-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; style-src 'unsafe-inline';${remoteLoadsCsp(remoteImagesBlocked, remoteImagesProxied)}">
      <base target="_blank">
    </head><body><div id="${SCALE_WRAPPER}" data-mf-doc="${String(docKey).replace(/\D/g, '')}">${
      // Images through the proxy load as the reader nears them (utils/frameLazyImages.js).
      (remoteImagesProxied ? deferProxiedImages(html) : html).replace(/<a(\s)/gi, '<a rel="noopener noreferrer"$1')
    }</div><style>
        /* Injected AFTER email HTML so our rules win the source-order tiebreak
           for same-specificity !important declarations inside the email's own
           <style> blocks (which land in <body> after the email HTML). */
        html, body { height: auto !important; min-height: 0 !important; overflow: hidden !important; }
        body { margin: 0 !important; padding: 0 !important;
               font-family: -apple-system, Arial, sans-serif;
               font-size: 14px; line-height: 1.6;
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
        pre, code { overflow-x: auto; white-space: pre-wrap; word-break: break-all; }
      </style><style id="${FRAME_STYLE.light}">
        body { background-color: #ffffff !important; color-scheme: light; color: #1a1a1a; }
        a { color: #6366f1; }
        blockquote { border-left: 3px solid #ddd; margin: 0; padding-left: 12px; color: #555; }
      </style><style id="${FRAME_STYLE.dark}" media="not all">
        /* MailFlow's dark background is not !important, so the sender's dark design can set its own. */
        body { background-color: ${palette.background}; color-scheme: dark; color: ${palette.text}; }
        a { color: ${palette.link}; }
        blockquote { border-left: 3px solid ${palette.border}; margin: 0; padding-left: 12px; color: ${palette.muted}; }
      </style><style id="${FRAME_STYLE.sender}" media="not all">${css}</style></body></html>`;
}
