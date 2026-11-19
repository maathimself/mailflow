import DOMPurify from 'dompurify';
import { remoteLoadsCsp } from './remoteImagePolicy.js';
import { formatDateTime } from './formatDate.js';

// Print documents for one message or a whole conversation (#521).
//
// The print window is same-origin and unsandboxed, so the CSP meta blocks any script in it, and
// the email HTML goes through DOMPurify first; together they neutralize a hostile body.

const esc = (s) => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const parseList = (raw) => {
  try { return Array.isArray(raw) ? raw : JSON.parse(raw || '[]'); } catch { return []; }
};
const fmtAddr = (r) => r.name ? `${esc(r.name)} &lt;${esc(r.email)}&gt;` : esc(r.email);

// The print window loads remote images as the email frame does (utils/remoteImagePolicy.js): none
// when a printed body was served blocked, through MailFlow's image proxy alone when proxied. Any
// one blocked message of a conversation is enough to load none, rather than a blocked one loading
// them.
const HEAD = (title, remoteBlocked = false, remoteProxied = false) => `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="script-src 'none'; object-src 'none'; base-uri 'none';${remoteLoadsCsp(remoteBlocked, remoteProxied)}"><title>${esc(title)}</title>`;

function metaHtml(message) {
  const date = formatDateTime(message.date);
  const fromStr = message.from_name
    ? `${esc(message.from_name)} &lt;${esc(message.from_email)}&gt;`
    : esc(message.from_email);
  const toStr = parseList(message.to_addresses).map(fmtAddr).join(', ');
  const ccStr = parseList(message.cc_addresses).map(fmtAddr).join(', ');
  return `<div class="meta">
    <div><span>From:</span> ${fromStr}</div>
    <div><span>To:</span> ${toStr}</div>
    ${ccStr ? `<div><span>Cc:</span> ${ccStr}</div>` : ''}
    <div><span>Date:</span> ${date}</div>
  </div>`;
}

function bodyHtml(body) {
  return body?.html
    ? DOMPurify.sanitize(body.html, { ADD_ATTR: ['target'] })
    : body?.text
      ? `<pre style="white-space:pre-wrap;font-family:sans-serif;font-size:14px">${esc(body.text)}</pre>`
      : '';
}

// entries: [{ message, body }] in reading order. One entry prints that message; several print the
// conversation under the first message's subject, each with its own sender, recipients and date.
export function buildPrintDocument(entries) {
  const first = entries[0]?.message || {};
  const remoteBlocked = entries.some(e => e.body?.remoteImagesBlocked);
  const remoteProxied = entries.some(e => e.body?.remoteImagesProxied);
  const subject = esc(first.subject) || '(no subject)';
  const style = `<style>
  body { font-family: Arial, sans-serif; font-size: 14px; color: #111; margin: 32px; }
  .header { border-bottom: 1px solid #ccc; padding-bottom: 16px; margin-bottom: 24px; }
  .header h1 { font-size: 18px; margin: 0 0 12px; }
  .meta { font-size: 13px; color: #444; line-height: 1.8; }
  .meta span { font-weight: 600; color: #111; }
  .message + .message { border-top: 1px solid #ccc; margin-top: 24px; padding-top: 16px; }
  .message .meta { margin-bottom: 16px; }
  @media print { body { margin: 16px; } }
</style></head><body>`;
  if (entries.length === 1) {
    return `${HEAD(first.subject, remoteBlocked, remoteProxied)}
${style}
<div class="header">
  <h1>${subject}</h1>
  ${metaHtml(first)}
</div>
${bodyHtml(entries[0].body)}
</body></html>`;
  }
  return `${HEAD(first.subject, remoteBlocked, remoteProxied)}
${style}
<div class="header"><h1>${subject}</h1></div>
${entries.map(({ message, body }) => `<div class="message">
  ${metaHtml(message)}
${bodyHtml(body)}
</div>`).join('\n')}
</body></html>`;
}

// Opened from the click itself, before any await: browsers block a window opened later.
let printWindowId = 0;
const printContext = new WeakMap();

function selectionNodes(root) {
  const walker = root.ownerDocument.createTreeWalker(root, 5, {
    acceptNode: node => node.parentElement?.closest('style, script') ? 2
      : node.nodeType === 3 || /^(IMG|BR|HR)$/.test(node.nodeName) ? 1 : 3,
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  return nodes;
}
// Images and line breaks count as one position, so an image-only selection is preserved too.
const nodeText = node => node.nodeType === 3 ? node.textContent : '\uFFFC';
const textOf = root => selectionNodes(root).map(nodeText).join('');

export function capturePrintSelection(root = document.body) {
  const capture = (doc, scope, messageId) => {
    const selection = doc.getSelection?.();
    if (!selection?.rangeCount || selection.isCollapsed) return null;
    const range = selection.getRangeAt(0);
    if (!scope?.contains(range.startContainer) || !scope.contains(range.endContainer)) return null;
    const prefix = doc.createRange();
    prefix.selectNodeContents(scope);
    prefix.setEnd(range.startContainer, range.startOffset);
    const start = textOf(prefix.cloneContents());
    const selected = textOf(range.cloneContents());
    if (!selected) return null;
    // Only offsets cross the reading/printing boundary; recolored DOM markup never does.
    return { messageId, start: start.length, end: start.length + selected.length, fullText: textOf(scope) };
  };
  for (const frame of root?.querySelectorAll('iframe') || []) {
    try {
      const doc = frame.contentDocument;
      const selection = capture(doc, doc.getElementById('mf-scale-wrapper') || doc.body, frame.closest('[data-message-id]')?.dataset.messageId);
      if (selection) return selection;
    } catch { /* A cross-origin frame cannot supply printable selection. */ }
  }
  const bodies = root?.querySelectorAll('[data-print-body], [data-mailflow-email]');
  for (const scope of bodies || []) {
    const selection = capture(document, scope, scope.closest('[data-message-id]')?.dataset.messageId);
    if (selection) return selection;
  }
  return bodies?.length ? null : capture(document, root, root?.closest('[data-message-id]')?.dataset.messageId);
}

export function buildPrintSelection(selection, entries) {
  if (!selection) return '';
  const entry = entries.length === 1 ? entries[0] : entries.find(({ message }) => String(message.id) === selection.messageId);
  if (!entry) return '';
  // Match the frame's parsing before sanitization changes head/body whitespace. This
  // detached document is inert; only the sanitized selection leaves it below.
  const source = document.implementation.createHTMLDocument('').createElement('div');
  source.innerHTML = entry.body?.html || bodyHtml(entry.body);
  if (textOf(source) !== selection.fullText) return '';
  const range = source.ownerDocument.createRange();
  let offset = 0;
  for (const node of selectionNodes(source)) {
    const end = offset + nodeText(node).length;
    if (selection.start >= offset && selection.start < end) {
      if (node.nodeType === 3) range.setStart(node, selection.start - offset);
      else range.setStartBefore(node);
    }
    if (selection.end > offset && selection.end <= end) {
      if (node.nodeType === 3) range.setEnd(node, selection.end - offset);
      else range.setEndAfter(node);
      break;
    }
    offset = end;
  }
  const ancestor = range.commonAncestorContainer;
  const element = ancestor.nodeType === 1 ? ancestor : ancestor.parentElement;
  const fragment = document.createElement('div');
  let content = range.cloneContents();
  for (let parent = element; parent !== source; parent = parent.parentElement) {
    const wrapper = parent.cloneNode(false);
    wrapper.append(content);
    content = wrapper;
  }
  for (const style of source.querySelectorAll('style')) fragment.append(style.cloneNode(true));
  fragment.append(content);
  return DOMPurify.sanitize(fragment.innerHTML);
}

export function openPrintWindow(placeholder = '', root = document.body) {
  // Capture before window.open changes focus, and before conversation loading can change it.
  const context = window.mailflowNative?.printing?.preview ? {
    selection: capturePrintSelection(root),
    language: document.documentElement.lang || 'en',
    accent: window.getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
    accentText: window.getComputedStyle(document.documentElement).getPropertyValue('--accent-text').trim(),
  } : null;
  // The desktop shell permits only these blank print windows. A unique name keeps a new
  // print from replacing a document that is still open in another print dialog.
  const win = window.open('', `mailflow-print-${++printWindowId}`);
  if (win && context) printContext.set(win, context);
  // The parent can still populate the document, but the email cannot reach its native bridge.
  if (win) win.opener = null;
  if (win && placeholder) {
    win.document.write(`${HEAD(placeholder)}</head><body><p style="font-family:sans-serif">${esc(placeholder)}</p></body></html>`);
  }
  return win;
}

export function printInWindow(win, html, entries = []) {
  if (!win || win.closed) return;
  win.document.open();
  win.document.write(html);
  win.document.close();
  if (window.mailflowNative?.printing?.preview) {
    // The desktop shell keeps this document hidden and opens its own PDF preview.
    // Errors are displayed by the shell, so event handlers need no async plumbing.
    const context = printContext.get(win) || {};
    const { selection, ...metadata } = context;
    return window.mailflowNative.printing.preview(win.name, {
      ...metadata, selectionHtml: buildPrintSelection(selection, entries),
    }).catch(() => { if (!win.closed) win.close(); });
  }
  win.focus();
  win.print();
}
