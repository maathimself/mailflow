import { stripOpeningTagStyleAttributes } from './htmlStyleSafety.js';

let fallbackSourceSequence = 0;

export function createEmailFrameSourceToken() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  fallbackSourceSequence += 1;
  return `${Date.now().toString(36)}-${fallbackSourceSequence.toString(36)}`;
}

function escapeHtmlAttribute(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export function emailFrameDocumentMatchesSource(documentRoot, sourceToken) {
  return documentRoot?.querySelector?.('meta[name="mailflow-source"]')?.content === sourceToken;
}

export function buildEmailFrameDocument(html, { recovery = false, sourceToken = '' } = {}) {
  // Recovery intentionally omits sender-owned style blocks. The marked base
  // sheet below remains, so a one-shot fallback can only reveal forced-light
  // content even if a previous root had inaccessible or unbounded CSS rules.
  const content = recovery
    ? stripOpeningTagStyleAttributes(
      html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ''),
    )
    : html;
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
    <meta name="mailflow-source" content="${escapeHtmlAttribute(sourceToken)}">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="color-scheme" content="light dark">
    <meta http-equiv="Content-Security-Policy" content="script-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; style-src 'unsafe-inline';">
    <base target="_blank">
  </head><body><div id="mf-scale-wrapper">${
    content.replace(/<a(\s)/gi, '<a rel="noopener noreferrer"$1')
  }</div><style data-mailflow-email-base>
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
      body > table, body > center > table,
      body > div > table, body > center > div > table,
      #mf-scale-wrapper > table, #mf-scale-wrapper > center > table,
      #mf-scale-wrapper > div > table, #mf-scale-wrapper > center > div > table {
        width: 100% !important;
      }
      td, th { min-width: 0 !important; }
      td { word-break: break-word; }
      th { overflow-wrap: normal; word-break: normal; }
      a { color: #6366f1; }
      pre, code { overflow-x: auto; white-space: pre-wrap; word-break: break-all; }
      blockquote { border-left: 3px solid #ddd; margin: 0; padding-left: 12px; color: #555; }
      html, body, #mf-scale-wrapper, html::before, html::after, body::before, body::after,
      #mf-scale-wrapper::before, #mf-scale-wrapper::after, #mf-scale-wrapper *,
      #mf-scale-wrapper *::before, #mf-scale-wrapper *::after {
        animation: none !important;
        transition: none !important;
      }
    </style></body></html>`;
}
