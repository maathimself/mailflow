// What the AI writing actions (Improve, Shorten, Fix grammar, Draft) are told about the sender and
// the sign-off.
//
// The sender's signature is added below the body when the message is sent, but the prompts never
// said so or said who is sending. Models polish an email by ending it with a closing line
// ("Thank you,") it did not have and by signing it, and with no name to sign with they write a
// placeholder such as [Your Name]. The real signature then follows underneath, so an applied
// result needed its sign-off deleted by hand.

const MAX_SIGNATURE_CHARS = 1000;
const BLOCK_TAGS = new Set(['P', 'DIV', 'LI', 'TR', 'TABLE', 'UL', 'OL', 'BLOCKQUOTE', 'PRE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);

/**
 * Signature HTML as plain text that keeps its line breaks, for a prompt. An image stands in as
 * "[image]", so a logo-only signature still reads as a signature.
 */
export function signatureText(html) {
  if (typeof html !== 'string' || !html.trim()) return '';
  const body = new DOMParser().parseFromString(html, 'text/html').body;
  let out = '';
  const atLineStart = () => !out || out.endsWith('\n');
  const newline = () => { out = out.replace(/ +$/, ''); if (!atLineStart()) out += '\n'; };
  const space = () => { if (!atLineStart() && !out.endsWith(' ')) out += ' '; };
  const walk = node => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        const text = child.nodeValue.replace(/\s+/g, ' ');
        out += atLineStart() || out.endsWith(' ') ? text.trimStart() : text;
      } else if (child.nodeName === 'BR') {
        out = out.replace(/ +$/, '') + '\n';
      } else if (child.nodeName === 'IMG') {
        space();
        out += '[image]';
      } else if (child.nodeType === 1 && child.nodeName !== 'STYLE' && child.nodeName !== 'SCRIPT') {
        const block = BLOCK_TAGS.has(child.nodeName);
        if (block) newline();
        walk(child);
        if (block) newline();
        else if (child.nodeName === 'TD' || child.nodeName === 'TH') space();
      }
    }
  };
  walk(body);
  return out.split('\n').map(line => line.trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_SIGNATURE_CHARS).trim();
}

/**
 * The part of a writing action's system prompt about the sender and the sign-off.
 * @param {object} sender
 * @param {string} [sender.name]       the sender's own name, if known
 * @param {string} [sender.signature]  the signature (plain text) that will be added below the body
 * @param {boolean} [sender.rewriting] true for actions that rework existing text (Improve, Shorten,
 *   Fix grammar), which must not add a closing or sign-off the email does not have
 */
export function aiSenderNote({ name, signature, rewriting = false } = {}) {
  const sender = typeof name === 'string' ? name.trim() : '';
  const sig = typeof signature === 'string' ? signature.trim() : '';
  const lines = [];
  if (sender) lines.push(`The email is from ${sender}.`);
  if (sig) lines.push("The sender's signature is added automatically below the text you return:", '"""', sig, '"""');
  if (rewriting) {
    lines.push('Keep the closing line, and any name after it, if the email has them, but do not add a closing line, sign-off, name or contact details that it does not have.');
  } else if (sig) {
    lines.push("Do not end the text with a signature, the sender's name or contact details, and if the signature already begins with a closing line (such as \"Thank you,\"), do not add another one.");
  } else if (sender) {
    lines.push(`No signature is added, so sign the email off as ${sender}.`);
  }
  lines.push('Never use placeholders such as [Your Name] or [Recipient Name]; leave out anything you do not know.');
  return lines.join('\n');
}
