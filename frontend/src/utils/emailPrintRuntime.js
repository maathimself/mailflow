import { applyEmailMediaMode } from './emailMediaMode.js';
import { prepareEmailHtml } from './scopeEmailCss.js';

const escapePrintText = value => (value || '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

const parseAddressList = raw => {
  try { return Array.isArray(raw) ? raw : JSON.parse(raw || '[]'); } catch { return []; }
};

export function writeEmailPrintDocument(targetWindow, { message, body }) {
  const date = message.date ? new Date(message.date).toLocaleString() : '';
  const from = message.from_name
    ? `${escapePrintText(message.from_name)} &lt;${escapePrintText(message.from_email)}&gt;`
    : escapePrintText(message.from_email);
  const formatAddress = row => row.name
    ? `${escapePrintText(row.name)} &lt;${escapePrintText(row.email)}&gt;`
    : escapePrintText(row.email);
  const to = parseAddressList(message.to_addresses).map(formatAddress).join(', ');
  const cc = parseAddressList(message.cc_addresses).map(formatAddress).join(', ');
  const prepared = body?.html ? prepareEmailHtml(body.html, 'print') : null;
  const senderStyleBlocks = prepared?.styleBlocks.slice(0, -1) || [];
  const finalBase = prepared?.styleBlocks.at(-1) || '';
  const bodyContent = prepared
    ? `${senderStyleBlocks.length ? `<style data-mailflow-email-print-sender>${senderStyleBlocks.join('\n')}</style>` : ''}
      <style data-mailflow-email-print-base data-mailflow-email-base>${finalBase}</style>
      <div class="${prepared.prefix}">${prepared.html}</div>`
    : body?.text
      ? `<pre style="white-space:pre-wrap;font-family:sans-serif;font-size:14px">${escapePrintText(body.text)}</pre>`
      : '';

  targetWindow.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="script-src 'none'; object-src 'none'; base-uri 'none'"><title>${escapePrintText(message.subject)}</title>
<style data-mailflow-email-print-shell data-mailflow-email-base>
  body { font-family: Arial, sans-serif; font-size: 14px; color: #111; margin: 32px; }
  .header { border-bottom: 1px solid #ccc; padding-bottom: 16px; margin-bottom: 24px; }
  .header h1 { font-size: 18px; margin: 0 0 12px; }
  .meta { font-size: 13px; color: #444; line-height: 1.8; }
  .meta span { font-weight: 600; color: #111; }
  @media print { body { margin: 16px; } }
</style></head><body>
<div class="header"><h1>${escapePrintText(message.subject) || '(no subject)'}</h1><div class="meta">
<div><span>From:</span> ${from}</div><div><span>To:</span> ${to}</div>
${cc ? `<div><span>Cc:</span> ${cc}</div>` : ''}<div><span>Date:</span> ${date}</div>
</div></div>${bodyContent}</body></html>`);
  targetWindow.document.close();
  return applyEmailMediaMode({
    root: targetWindow.document,
    styleSheets: [...targetWindow.document.styleSheets],
    scheme: 'light',
    failClosed: true,
  });
}

export function printEmailWindow(targetWindow, payload) {
  const preparation = writeEmailPrintDocument(targetWindow, payload);
  if (preparation.status !== 'ready') {
    targetWindow.close?.();
    return preparation;
  }
  targetWindow.focus();
  targetWindow.print();
  return preparation;
}
