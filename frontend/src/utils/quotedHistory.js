// The quoted history at the end of a reply, which the Gmail layout hides behind a "•••" toggle.
//
// Only the end of a body is ever trimmed, never a forwarded message's content, and never a body
// that is nothing but the quote: hiding the part of an email the reader came for is worse than
// showing a quote twice.

export const TRIMMED_CLASS = 'mf-trimmed';

const FORWARD_SUBJECT = /^\s*(?:fwd?|wg|tr|rv|enc|pd|vs|doorst|i)\s*:/i;
const FORWARD_HEADER = /-{2,}\s*forwarded message|begin forwarded message/i;

// A forward's content is the message itself, however its client marks it up.
export const isForwardSubject = subject => FORWARD_SUBJECT.test(subject || '');

// "On Mon, Jan 1, 2026 at 10:00 Ana <a@x.z> wrote:", in any language: short, ends in a colon,
// carries a date.
const looksLikeAttribution = text => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > 0 && line.length < 400 && /:$/.test(line) && /\d/.test(line);
};

function hasContent(node) {
  if (node.nodeType === 3) return /\S/.test(node.nodeValue);
  if (node.nodeType !== 1 || node.tagName === 'STYLE') return false;
  return node.tagName === 'IMG' || [...node.childNodes].some(hasContent);
}

function textOf(node) {
  if (node.nodeType === 3) return node.nodeValue;
  if (node.nodeType !== 1 || node.tagName === 'STYLE') return '';
  if (node.tagName === 'BR') return '\n';
  return [...node.childNodes].map(textOf).join('');
}

function contentAfter(node, root) {
  for (let n = node; n && n !== root; n = n.parentNode) {
    for (let s = n.nextSibling; s; s = s.nextSibling) if (hasContent(s)) return true;
  }
  return false;
}

function contentBefore(node, root) {
  for (let n = node; n && n !== root; n = n.parentNode) {
    for (let s = n.previousSibling; s; s = s.previousSibling) if (hasContent(s)) return true;
  }
  return false;
}

const meaningful = (node, step) => {
  let s = node[step];
  while (s && !hasContent(s)) s = s[step];
  return s;
};

// Where a blockquote's history starts: at the attribution line just above it, when there is one.
// Apple Mail and Thunderbird mark the quote type="cite", and the attribution may sit inside it;
// without the attribute, which the server's sanitizer drops, a blockquote needs an attribution to
// count as history rather than a passage the sender quoted.
function blockquoteStart(quote) {
  const prev = meaningful(quote, 'previousSibling');
  if (prev && ((prev.nodeType === 1 && prev.classList.contains('moz-cite-prefix')) || looksLikeAttribution(textOf(prev)))) {
    return prev;
  }
  const first = [...quote.childNodes].find(hasContent);
  const cite = quote.getAttribute('type') === 'cite' || (first && looksLikeAttribution(textOf(first)));
  return cite ? quote : null;
}

// A reply written between the quoted lines, as Gmail puts it inside its quote container: what is
// past the first quoted block is the reply, not history.
function interleaved(container) {
  let quoted = false;
  for (const child of container.childNodes) {
    if (child.nodeType === 1 && child.tagName === 'BLOCKQUOTE') quoted = true;
    else if (quoted && hasContent(child)) return true;
  }
  return false;
}

const outermost = (nodes, selector) => nodes.filter(node => !node.parentElement?.closest(selector));

// Where the history starts, and whether everything after that point in the body goes with it.
function findQuote(root) {
  const outlook = root.querySelector('#appendonsend, #divRplyFwdMsg');
  if (outlook) {
    const prev = meaningful(outlook, 'previousSibling');
    const start = outlook.id === 'divRplyFwdMsg' && prev?.nodeType === 1 && prev.tagName === 'HR' ? prev : outlook;
    return { start, toEnd: true };
  }
  const gmail = '.gmail_quote_container, div.gmail_quote';
  const candidates = [
    ...outermost([...root.querySelectorAll(gmail)], gmail).filter(node => !interleaved(node))
      .map(node => ({ quote: node, start: node })),
    ...[...root.querySelectorAll('.yahoo_quoted')].map(node => ({ quote: node, start: node })),
    ...outermost([...root.querySelectorAll('blockquote')], 'blockquote')
      .map(node => ({ quote: node, start: blockquoteStart(node) }))
      .filter(candidate => candidate.start),
  ].filter(candidate => !contentAfter(candidate.quote, root));
  if (!candidates.length) return null;
  const { start } = candidates.reduce((first, candidate) => (
    first.start.compareDocumentPosition(candidate.start) & 2 /* DOCUMENT_POSITION_PRECEDING */ ? candidate : first));
  return { start, toEnd: false };
}

function historyNodes(start, toEnd, root) {
  const nodes = [start];
  for (let s = start.nextSibling; s; s = s.nextSibling) nodes.push(s);
  if (toEnd) {
    for (let n = start.parentNode; n && n !== root; n = n.parentNode) {
      for (let s = n.nextSibling; s; s = s.nextSibling) nodes.push(s);
    }
  } else {
    // An empty line after the quote stays where it is.
    while (nodes.length > 1 && !hasContent(nodes.at(-1))) nodes.pop();
  }
  return nodes;
}

function trimmedToggle(doc, labels) {
  const details = doc.createElement('details');
  details.className = TRIMMED_CLASS;
  const summary = doc.createElement('summary');
  for (const [key, label] of [['show', labels.show], ['hide', labels.hide]]) {
    const span = doc.createElement('span');
    span.className = `${TRIMMED_CLASS}-${key}`;
    span.title = label;
    span.setAttribute('aria-label', label);
    span.textContent = '•••';
    summary.appendChild(span);
  }
  details.appendChild(summary);
  return details;
}

// The email's HTML with its trailing quoted history folded into a closed <details>, or null when
// there is none to fold. A <details> opens without script, which the frame's CSP and sandbox
// forbid. `labels`: { show, hide }, the toggle's titles.
export function trimQuotedHtml(html, labels, doc = globalThis.document) {
  if (!html || !doc) return null;
  const template = doc.createElement('template');
  template.innerHTML = html;
  const root = template.content;
  const quote = findQuote(root);
  if (!quote || !contentBefore(quote.start, root)) return null;
  const nodes = historyNodes(quote.start, quote.toEnd, root);
  if (FORWARD_HEADER.test(nodes.map(textOf).join('').slice(0, 600))) return null;
  const details = trimmedToggle(root.ownerDocument, labels);
  quote.start.parentNode.insertBefore(details, quote.start);
  for (const node of nodes) details.appendChild(node);
  return template.innerHTML;
}

// A plain-text body split before its trailing "> " lines and their "On … wrote:" line, or null
// when it has none to split.
export function splitQuotedText(text) {
  if (!text) return null;
  const lines = text.split('\n');
  let end = lines.length;
  while (end > 0 && !lines[end - 1].trim()) end--;
  let start = end;
  while (start > 0 && (/^\s*>/.test(lines[start - 1]) || !lines[start - 1].trim())) start--;
  while (start < end && !lines[start].trim()) start++;
  if (start === end) return null;
  // The attribution, maybe a blank line above the quote, and maybe wrapped onto a second line.
  let above = start;
  while (above > 0 && !lines[above - 1].trim()) above--;
  if (above > 0 && /:\s*$/.test(lines[above - 1])) {
    if (looksLikeAttribution(lines[above - 1])) start = above - 1;
    else if (above > 1 && looksLikeAttribution(`${lines[above - 2]} ${lines[above - 1]}`)) start = above - 2;
  }
  const body = lines.slice(0, start).join('\n').replace(/\s+$/, '');
  const quoted = lines.slice(start, end).join('\n');
  if (!/\S/.test(body) || FORWARD_HEADER.test(quoted.slice(0, 600))) return null;
  return { body, quoted };
}
