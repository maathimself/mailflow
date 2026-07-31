export function cacheCanonicalEmailBody(cache, order, messageId, body, limit = 50) {
  cache[messageId] = body;
  order.push(messageId);
  if (order.length > limit) {
    const evicted = order.shift();
    delete cache[evicted];
  }
  return body;
}

export function buildReplyBodyContent({ body, date, from }) {
  return {
    text: body?.text
      ? `\n\n---\nOn ${date}, ${from} wrote:\n${body.text.split('\n').map(line => `> ${line}`).join('\n')}`
      : '',
    html: body?.html
      ? `<div style="border-left:3px solid var(--border,#ccc);padding-left:12px;margin-top:12px;color:var(--text-secondary,#666)"><p style="margin:0 0 6px;font-size:12px">On ${date}, ${from} wrote:</p>${body.html}</div>`
      : null,
  };
}

export function buildForwardBodyContent({ body, date, from, subject, to, cc }) {
  return {
    text: `\n\n---------- Forwarded message ----------\nFrom: ${from}\nDate: ${date}\nSubject: ${subject}${to ? `\nTo: ${to}` : ''}${cc ? `\nCc: ${cc}` : ''}\n\n${body?.text || ''}`,
    html: body?.html
      ? `<div style="border-left:3px solid var(--border,#ccc);padding-left:12px;margin-top:12px;color:var(--text-secondary,#666)"><p style="margin:0 0 6px;font-size:12px">---------- Forwarded message ----------<br>From: ${from}<br>Date: ${date}<br>Subject: ${subject}${to ? `<br>To: ${to}` : ''}${cc ? `<br>Cc: ${cc}` : ''}</p>${body.html}</div>`
      : null,
  };
}

export function emailBodyTextForAi(body) {
  return body?.text
    || body?.html?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    || '';
}
