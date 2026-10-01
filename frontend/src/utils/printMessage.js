import DOMPurify from 'dompurify';

// Print documents for one message or a whole conversation (#521).
//
// The print window is same-origin and unsandboxed, so the CSP meta blocks any script in it, and
// the email HTML goes through DOMPurify first; together they neutralize a hostile body.

const esc = (s) => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const parseList = (raw) => {
  try { return Array.isArray(raw) ? raw : JSON.parse(raw || '[]'); } catch { return []; }
};
const fmtAddr = (r) => r.name ? `${esc(r.name)} &lt;${esc(r.email)}&gt;` : esc(r.email);

const HEAD = (title) => `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="script-src 'none'; object-src 'none'; base-uri 'none'"><title>${esc(title)}</title>`;

function metaHtml(message) {
  const date = message.date ? new Date(message.date).toLocaleString() : '';
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
    return `${HEAD(first.subject)}
${style}
<div class="header">
  <h1>${subject}</h1>
  ${metaHtml(first)}
</div>
${bodyHtml(entries[0].body)}
</body></html>`;
  }
  return `${HEAD(first.subject)}
${style}
<div class="header"><h1>${subject}</h1></div>
${entries.map(({ message, body }) => `<div class="message">
  ${metaHtml(message)}
${bodyHtml(body)}
</div>`).join('\n')}
</body></html>`;
}

// Opened from the click itself, before any await: browsers block a window opened later.
export function openPrintWindow(placeholder = '') {
  const win = window.open('', '_blank');
  if (win && placeholder) {
    win.document.write(`${HEAD(placeholder)}</head><body><p style="font-family:sans-serif">${esc(placeholder)}</p></body></html>`);
  }
  return win;
}

export function printInWindow(win, html) {
  if (!win || win.closed) return;
  win.document.open();
  win.document.write(html);
  win.document.close();
  win.focus();
  win.print();
}
