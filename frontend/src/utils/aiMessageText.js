// The text an AI action (#202) sends to the model: what the user reads, not what the MIME
// part contains. HTML-only emails used to go in as raw HTML with tags stripped by a
// catch-all regex (#646), which left the contents of <style> blocks, the whole quoted
// history below the reply and bare tracking URLs in the prompt — Translate then
// "translated" CSS and previous turns of the thread instead of the message.
//
// Cutting is lossy, so who gets cut is narrow (#647 review): a built-in action gets the
// sender's message alone, with quoted history cut only where it trails the reply. Custom
// actions ({ full: true }) are left whole — their prompts may need the thread and the
// links, and a cut loses forwards, inline answers and quoted context they asked for.

import { stripTags } from './stripTags.js';

// A text/plain part that is really a raw HTML document (some senders put one in). Same
// detection as the backend snippet builder (services/messageParser.js looksLikeHtml).
function looksLikeHtml(text) {
  const head = text.slice(0, 2048);
  if (/^\s*<(?:!doctype|html|head|body)[\s>]/i.test(head)) return true;
  if (/<[a-z][a-z0-9]*\s[^>]*=[^>]*>/i.test(head)) return true;
  if (/<(?:style|script)[\s>]/i.test(head)) return true;
  const closingTags = head.match(/<\/[a-z][a-z0-9]*\s*>/gi);
  return closingTags !== null && closingTags.length >= 3;
}

// The document-grade subset of looksLikeHtml: without an HTML part to prefer, this is
// what justifies parsing a text/plain part instead of sending it as written. The
// attribute-tag rule alone is not enough — prose quoting "<img src=…>" is the sender's
// content, and parsing it ate the snippet and flattened its spacing (#647 review). The
// backend snippet keeps the wider rule: there the loss is one line, not the whole part.
function looksLikeHtmlDocument(text) {
  const head = text.slice(0, 2048);
  if (/^\s*<(?:!doctype|html|head|body)[\s>]/i.test(head)) return true;
  if (/<(?:style|script)[\s>]/i.test(head)) return true;
  const closingTags = head.match(/<\/[a-z][a-z0-9]*\s*>/gi);
  return closingTags !== null && closingTags.length >= 3;
}

// Elements whose text content never renders, so leaving them in would hand the model CSS
// and script debris as if it were body text.
const INERT_SELECTOR = 'script, style, head, title, noscript, template';

// Wrappers mail clients put around quoted history: the cite-marked blockquote (Apple Mail,
// Thunderbird), plus Gmail's div.gmail_quote/div.gmail_attr and Yahoo's yahoo_quoted. A
// blockquote without type=cite is not necessarily quoting mail at all — a message that
// ends by quoting a contract clause or a saying loses it otherwise (#647 review) — and
// Outlook's quotes are unclassed plain paragraphs, caught by the text-level pass
// (stripQuotedHistory) below.
const QUOTE_WRAPPER_SELECTOR = 'blockquote[type=cite], [class*="gmail_quote"], [class*="gmail_attr"], [class*="yahoo_quoted"]';

// Forward markers: Gmail's "---------- Forwarded message ---------" (in the client's UI
// language) and Apple Mail's "Begin forwarded message:". A forward carries a whole other
// email, so it is content, never history: a wrapper that opens with one stays, and the
// text pass stops cutting past one. Gmail used to forward as a gmail_quote wrapper alone
// and the action went out empty or as just the note above the forward (#647 review).
const FORWARD_MARKER_RE = new RegExp(
  '^\\s{0,8}(?:begin\\s+forwarded\\s+message|начало\\s+пересылаемого\\s+сообщения'
  + '|[-–—_=]{4,}\\s*(?:begin\\s+)?(?:forwarded\\s+message|пересланное\\s+сообщение'
  + '|weitergeleitete\\s+nachricht|välitetty\\s+viesti|mensaje\\s+reenviado'
  + '|message\\s+transféré|messaggio\\s+inoltrato|doorgestuurd\\s+bericht'
  + '|przekazana\\s+wiadomość|mensagem\\s+encaminhada))', 'i');

// Block-level elements: text inside gets line boundaries, so paragraphs survive extraction
// as separate lines (textContent alone welds every paragraph into one run).
const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'caption', 'center', 'dd', 'div', 'dl', 'dt', 'fieldset',
  'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header',
  'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'tbody', 'td', 'tfoot', 'th',
  'thead', 'tr', 'ul',
]);

// Visible text of a node with block boundaries as newlines: textContent alone welds
// paragraphs into one run, and both the extraction and the quote/forward checks below
// read line shapes ("first line is a marker", "From: … / Sent: … on their own lines").
function nodeText(node, keepQuotes) {
  const out = [];
  const walk = (current) => {
    for (const child of current.childNodes) {
      if (child.nodeType === 3 /* text */) { out.push(child.nodeValue); continue; }
      if (child.nodeType !== 1 /* element */) continue;
      const name = child.tagName.toLowerCase();
      if (name === 'br') { out.push('\n'); continue; }
      // In full mode an anchor keeps its target: a custom prompt may need the link, and
      // textContent alone drops it ("the agenda" without the URL, #647 review). An anchor
      // with no words (an image, a spacer) has nothing to attach a target to — the bare
      // "(https://…)" it used to leave was most of a link-heavy newsletter's prompt
      // (#647 review).
      if (name === 'a' && keepQuotes) {
        const href = (child.getAttribute('href') || '').trim();
        const label = nodeText(child, keepQuotes);
        if (!label.trim()) continue;
        const bare = href.startsWith('mailto:') && href.slice(7) === label.trim();
        out.push(href && href !== label.trim() && !bare ? `${label} (${href})` : label);
        continue;
      }
      const block = BLOCK_TAGS.has(name);
      if (block) out.push('\n');
      walk(child);
      if (block) out.push('\n');
    }
  };
  walk(node);
  return out.join('');
}

// A wrapper that carries a forwarded email is content, not history, whatever language the
// client marks it in (#647 review): the marker list above cannot cover every locale, so a
// wrapper is a forward by structure — it opens with a forward marker or with a header run
// naming another mail (From/Sent/Date/Subject), or, for the class-based wrappers, it holds
// no nested blockquote (a reply nests the quoted body in one, a forward doesn't). An
// attribution line ("On … wrote:") above the body names a reply, never a forward.
function isForwardWrapper(node) {
  const lines = nodeText(node).split('\n');
  let first = -1;
  let second = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    if (first < 0) { first = i; continue; }
    second = i;
    break;
  }
  if (first < 0) return false;
  if (FORWARD_MARKER_RE.test(lines[first])) return true;
  if (QUOTE_INTRO_RE.test(lines[first]) && looksAttributed(lines[first])) return false;
  // An Apple forward puts its marker (in any language) on the first line and the header
  // run under it, so a full run at either of the first two non-blank lines says forward.
  if (quoteHeaderRunSubject(lines, first) !== null) return true;
  if (second >= 0 && quoteHeaderRunSubject(lines, second) !== null) return true;
  return node.tagName !== 'BLOCKQUOTE' && !node.querySelector('blockquote');
}

// Cut a wrapper only where it is trailing quoted history: real text above it (else the
// wrapper is the whole message — a Gmail forward with no note lives entirely inside
// div.gmail_quote), no real text after it (a newsletter pull-quote is a mid-document
// blockquote, an inline answer continues below its quote), and not a forward (#647
// review). Wrappers nested in wrappers are content of their parent, not their own call.
function cutTrailingQuoteWrappers(root) {
  const segments = [];
  let run = null;
  const flush = () => {
    if (run && run.join('').trim()) segments.push({ text: run });
    run = null;
  };
  const walk = (node, wrapped) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3 /* text */) {
        if (!wrapped) (run || (run = [])).push(child.nodeValue);
        continue;
      }
      if (child.nodeType !== 1 /* element */) continue;
      const name = child.tagName.toLowerCase();
      const breaks = name === 'br' || BLOCK_TAGS.has(name);
      if (breaks && !wrapped) (run || (run = [])).push('\n');
      const quote = !wrapped && child.matches(QUOTE_WRAPPER_SELECTOR);
      if (quote) { flush(); segments.push({ node: child }); }
      walk(child, wrapped || quote);
      if (breaks && !wrapped) (run || (run = [])).push('\n');
    }
  };
  walk(root, false);
  flush();

  const real = seg => seg.text && seg.text.join('').replace(/\s+/g, ' ').trim();
  const before = new Array(segments.length).fill(false);
  const after = new Array(segments.length).fill(false);
  let seen = false;
  for (let i = 0; i < segments.length; i++) { before[i] = seen; if (real(segments[i])) seen = true; }
  seen = false;
  for (let i = segments.length - 1; i >= 0; i--) { after[i] = seen; if (real(segments[i])) seen = true; }
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.node && before[i] && !after[i] && !isForwardWrapper(seg.node)) seg.node.remove();
  }
}

function htmlToText(html, keepQuotes, subject = '') {
  let doc;
  try {
    doc = new DOMParser().parseFromString(html, 'text/html');
  } catch {
    // The parser refusing the input is not a reason to send raw HTML: tags to spaces is
    // still linear and still leaves no CSS (#647 review).
    return stripTags(html);
  }
  // The walks below recurse, so a pathological tree (jsdom throws a RangeError at
  // ~10,000 nested nodes) can blow the stack; the fallback covers that too — a dead
  // click is worse than degraded text (#647 review).
  try {
    doc.querySelectorAll(INERT_SELECTOR).forEach(el => el.remove());
    // A forward's wrappers are the forwarded mail. Apple Mail forwards inside a cite
    // blockquote — the same element that carries a reply's quote — and marks it in the
    // client's language, so a Fwd: prefix on the envelope subject decides here too,
    // before any label list can miss (#647 review).
    if (!keepQuotes && !FORWARD_SUBJECT_PREFIX_RE.test(subject)) {
      cutTrailingQuoteWrappers(doc.body || doc.documentElement);
    }
    return nodeText(doc.body || doc.documentElement, keepQuotes);
  } catch {
    return stripTags(html);
  }
}

// "On Mon, Oct 19, 2026 at 8:27 AM X <x@y.z> wrote:" — the attribution line Gmail, Apple
// Mail and Thunderbird put above the quoted history, including localized variants.
const QUOTE_INTRO_RE = new RegExp(
  '^\\s{0,8}.{1,220}(?:wrote|schrieb|schreef|a écrit|ha scritto|escribió|escreveu'
  + '|kirjoitti|napisał(?:a)?|написал(?:а)?|写道|작성)\\s*[:：]\\s*$', 'i');

// Real attributions name a time or an address. Prose can end in "wrote:" too ("focus on
// what the author wrote:") and never starts a cut by itself — but a `>`-quoted block
// under it is still trailing history and still cuts at its first quoted line.
const looksAttributed = line => /\d/.test(line) || /<[^<>]+@[^<>]+>/.test(line);

// Localized quote-header labels (Outlook desktop quotes are unclassed paragraphs of
// `Label: value` lines in the sender's UI language). One such line alone could be a
// signature footer, so a cut needs a header run — and a full one: who sent it, when and
// about what. Two or three generic labels used to be enough, and structured mail paid
// for it (#647 review): a shipping notice's "From: Berlin / To: Paris / Date: …" read as
// a quote header and the itinerary below was cut, an event notice lost its details.
const QUOTE_HEADER_LINE_RE = new RegExp(
  '^\\s{0,8}(?:from|sent|to|cc|bcc|subject|date|reply|sender'
  + '|от|отправлено|кому|копия|тема|дата|ответ'
  + '|lähettäjä|lähetetty|vastaanottaja|aihe|kopio|päiväys'
  + '|von|an|gesendet|betreff|datum|kopie'
  + '|de|à|envoyé|objet'
  + '|para|enviado|asunto|fecha'
  + '|da|inviato|oggetto'
  + '|enviada|assunto'
  + '|van|aan|verzonden|onderwerp'
  + '|od|do|wysłano|temat|komu|odesláno|předmět'
  + ')\\s*:', 'i');

const HEADER_FROM_RE = /^\s{0,8}(?:from|von|de|da|od|van|lähettäjä|от)\s*:/i;
const HEADER_DATE_RE = /^\s{0,8}(?:sent|date|gesendet|datum|envoyé|enviado|inviato|wysłano|odesláno|verzonden|enviada|lähetetty|päiväys|дата|отправлено)\s*:/i;
const HEADER_SUBJECT_RE = /^\s{0,8}(?:subject|betreff|objet|asunto|oggetto|onderwerp|aihe|тема|temat|předmět|assunto)\s*:/i;

// A quote header is a tight block of label lines naming a From, a Sent/Date and a
// Subject; any ordinary line ends it. Bounded, so hostile input stays linear. Returns
// the Subject value when the run is full, null when it is not — the value says whether
// the block quotes this thread's reply or starts another mail.
function quoteHeaderRunSubject(lines, from) {
  let subject = null;
  const kinds = new Set();
  let seen = 0;
  for (let i = from; i < lines.length && seen < 12; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    seen++;
    if (HEADER_FROM_RE.test(line)) kinds.add('from');
    else if (HEADER_DATE_RE.test(line)) kinds.add('date');
    else {
      const label = line.match(HEADER_SUBJECT_RE);
      if (label) { kinds.add('subject'); subject = line.slice(label[0].length).trim(); }
      else if (!QUOTE_HEADER_LINE_RE.test(line)) break;
    }
  }
  return kinds.has('from') && kinds.has('date') && kinds.has('subject') ? subject : null;
}

// A full header run quotes this thread's history only when this mail is a reply (a reply
// prefix on the envelope subject) and the run's Subject is the same subject. Anything
// else — a list digest whose first message is a reply, a contact form, a delivery
// report — starts content, not history, whatever sits above (#647 review). With no
// envelope subject to compare, a reply prefix on the run's own Subject has to do.
const REPLY_SUBJECT_VALUE_RE = /^\s*(?:re|aw|sv|vs|odp|odw|antw|r|ref|ответ)\s*:/i;

// Outlook forwards carry no marker of their own — their header block is shaped exactly
// like a reply's — so the envelope subject is the tell: a forward prefix there says the
// block starts a forwarded mail and nothing below it is history (#647 review). VS: is
// kept on the forward side on purpose: the same abbreviation is a reply's ("vastaus")
// in Finnish Outlook and a forward's elsewhere, and the subject alone cannot tell them
// apart — a reply that keeps its quoted history costs redundancy, while a forward cut
// as a reply loses the forwarded mail (#647 review).
const FORWARD_SUBJECT_PREFIX_RE = /^\s*(?:fwd|fw|wg|tr|rv|i|vs)\s*:/i;

// A subject without its reply/forward prefixes and [list] tags, for comparing two of
// them: "RE: [team] Fwd: Invoice 42" and "Invoice 42" name the same thread.
const SUBJECT_PREFIXES_RE = /^(?:\s*(?:(?:re|aw|sv|vs|odp|odw|antw|r|ref|ответ|fwd|fw|wg|tr|rv|i)(?:\[\d+\])?\s*[:：]|\[[^\]]{0,60}\]))+/i;
const baseSubject = s => s.replace(SUBJECT_PREFIXES_RE, '').replace(/\s+/g, ' ').trim().toLowerCase();

// Cut the message at the line that opens trailing quoted history — the previous turn,
// which the sender did not write. Four shapes, in order:
//   1. a forward marker, or a full header run that does not quote this thread (a forward
//      prefix on the envelope subject, or a Subject other than the thread's): content,
//      not history — the rest of the message is the forwarded mail, stop cutting;
//   2. an attribution line ("On … X wrote:", "… X kirjoitti:") naming a time or address,
//      with the quote below it `>`-quoted to the end (an unprefixed body could be the
//      reader's own continuation, so no cut);
//   3. a full quote-header run (From + Sent/Date + Subject) quoting this thread;
//   4. `>`-quoted lines running to the end.
// A cut only lands where the message has real content above it: a body that is nothing
// but a quote, or that opens with a pasted header block, keeps its text.
export function stripQuotedHistory(text, { subject = '' } = {}) {
  const lines = text.split('\n');
  const isQuoteLine = line => /^\s{0,8}>/.test(line)
    || (QUOTE_INTRO_RE.test(line) && looksAttributed(line));
  // One backward pass instead of a scan per quote line (#647 review): the last non-blank
  // line that is neither `>`-quoted nor an attribution is the reader's last own words —
  // a quote block that starts after it runs to the end of the message. Real text below a
  // quote (an inline answer, a signature) means the quote is not the tail, and scanning
  // for that from every quote line was quadratic on hostile input.
  let lastOwn = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.trim() || isQuoteLine(line)) continue;
    lastOwn = i;
    break;
  }
  const envelopeForward = FORWARD_SUBJECT_PREFIX_RE.test(subject);
  let sawContent = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (isQuoteLine(line)) {
      if (sawContent && i > lastOwn) return lines.slice(0, i).join('\n');
    } else if (FORWARD_MARKER_RE.test(line)) {
      return text;
    } else if (QUOTE_HEADER_LINE_RE.test(line)) {
      const runSubject = quoteHeaderRunSubject(lines, i);
      if (runSubject === null) continue;
      // A header block is this thread's history only when this mail is a reply and the
      // block names the same thread; a digest's first message or a contact form can
      // carry a Re: subject of its own without quoting anything (#647 review).
      const quotesThread = subject
        ? REPLY_SUBJECT_VALUE_RE.test(subject) && baseSubject(runSubject) === baseSubject(subject)
        : REPLY_SUBJECT_VALUE_RE.test(runSubject);
      if (envelopeForward || !quotesThread) return text;
      if (sawContent) return lines.slice(0, i).join('\n');
    } else {
      sawContent = true;
    }
  }
  return text;
}

// Junk that carries nothing the model needs (mirrors the backend snippet cleanup in
// services/messageParser.js): zero-width filler, [image: …] placeholders from
// HTML-to-text converters and, unless keepLinks, bare link targets — the anchor's own
// words stay — plus the empty wrappers the URL strip leaves behind. keepSpacing leaves
// runs of spaces alone for a real text/plain part: a table's column alignment is
// content, while extracted HTML is sprayed with markup spacing anyway (#647 review).
export function cleanForAi(text, { keepLinks = false, keepSpacing = false } = {}) {
  let out = text
    .replace(/[\u00ad\u200b-\u200d\ufeff]/g, '')
    .replace(/\[image:[^\]]*\]|(\[image:[^\]]*)/gi, '$1');
  if (!keepLinks) {
    out = out
      .replace(/(?:https?:\/\/|mailto:)[^\s<>()[\]]+/gi, '')
      .replace(/(?<![\w@.])www\.[^\s<>()[\]]+/gi, '')
      .replace(/\(\s*\)|\[\s*\]|<\s*>/g, ' ');
  }
  return (keepSpacing ? out : out.replace(/[ \t]+/g, ' '))
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// The model-facing text of a message: the text/plain part when it is real text, otherwise
// the HTML part extracted to visible text (or the degenerate text part parsed as HTML).
// Junk is cleaned on either path. Default (built-in actions) also cuts trailing quoted
// history; { full: true } (custom actions) keeps quotes and links. Empty input stays empty.
// The envelope subject tells an Outlook forward (no marker, "Fwd:" subject) from a reply.
export function aiMessageText(body, { full = false, subject = '' } = {}) {
  if (!body) return '';
  const text = typeof body.text === 'string' ? body.text : '';
  const html = typeof body.html === 'string' ? body.html : '';
  const finish = (t, spacing) => {
    const cleaned = cleanForAi(t, { keepLinks: full, keepSpacing: spacing });
    return full ? cleaned : stripQuotedHistory(cleaned, { subject });
  };
  if (text && !looksLikeHtml(text)) return finish(text, true);
  // Without an HTML part to prefer, only a text/plain that is a real document goes to
  // the parser; prose that merely mentions a tag is sent as written (#647 review).
  if (html || (text && looksLikeHtmlDocument(text))) return finish(htmlToText(html || text, full, subject));
  if (text) return finish(text, true);
  return '';
}
