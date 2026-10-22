// The text AI actions send to the model: visible content of the message, with junk
// cleaned; built-in actions additionally get trailing quoted history cut, custom actions
// are left whole (#646, #647 review). Extraction needs a DOM parser, so like the other
// DOM-bound utils this runs under jsdom.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.DOMParser = dom.window.DOMParser;
const { aiMessageText, stripQuotedHistory } = await import('./aiMessageText.js');

describe('aiMessageText', () => {
  it('extracts visible text from HTML: no style contents, paragraphs on their own lines', () => {
    const out = aiMessageText({ html: '<style>p{margin-bottom: 0;}</style><p>Hello Daniil,</p><p>Thank you for the update.</p>' });
    assert.equal(out, 'Hello Daniil,\n\nThank you for the update.');
  });

  it('cuts trailing quote wrappers (cite blockquote, gmail_quote/gmail_attr) with everything inside', () => {
    const out = aiMessageText({ html: '<p>My answer.</p><blockquote type="cite"><p>Old message</p></blockquote>'
      + '<div class="gmail_quote"><div class="gmail_attr">On Mon, Oct 19, 2026 at 8:27 AM X &lt;x@y.z&gt; wrote:</div>'
      + '<p>Quoted body</p></div>' });
    assert.equal(out, 'My answer.');
  });

  it('keeps a contract clause quoted in a plain blockquote at the end (#647 review)', () => {
    const out = aiMessageText({ html: '<p>See clause 4:</p><blockquote><p>The licence is granted as-is.</p></blockquote>' });
    assert.match(out, /The licence is granted as-is\./);
  });

  it('keeps a wrapper that is the whole message: a Gmail forward with no note (#647 review 1)', () => {
    const html = '<div class="gmail_quote"><div class="gmail_attr">---------- Forwarded message ---------<br />'
      + 'From: Anna &lt;anna@exempel.fi&gt;<br />Date: Sun, Oct 18, 2026 at 9:14 PM<br />'
      + 'Subject: Fwd: Invoice 42<br />To: me &lt;me@example.com&gt;</div>'
      + '<div dir="ltr"><p>Invoice attached, please pay before Friday.</p></div></div>';
    const out = aiMessageText({ html });
    assert.match(out, /Invoice attached, please pay before Friday/);
    assert.match(out, /Forwarded message/);
  });

  it('keeps a forward below a note: Gmail wrapper, Apple blockquote, plain text (#647 review 2)', () => {
    const gmail = aiMessageText({ html: '<div dir="ltr">See below.</div><br />'
      + '<div class="gmail_quote"><div class="gmail_attr">---------- Forwarded message ---------<br />'
      + 'From: Anna &lt;anna@exempel.fi&gt;<br />Subject: Invoice 42</div>'
      + '<div dir="ltr"><p>Invoice attached.</p></div></div>' });
    assert.match(gmail, /See below\./);
    assert.match(gmail, /Invoice attached\./);

    const apple = aiMessageText({ html: '<div>See below.</div>'
      + '<blockquote type="cite"><div>Begin forwarded message:</div>'
      + '<div>From: Anna</div><p>Invoice attached.</p></blockquote>' });
    assert.match(apple, /See below\./);
    assert.match(apple, /Invoice attached\./);

    const plain = stripQuotedHistory('Переслал счёт.\n\n-------- Пересланное сообщение --------\n'
      + 'От: Бухгалтерия\nДата: 18 октября 2026 г.\nТема: Счёт\nКому: мне\n\nСчёт во вложении.');
    assert.match(plain, /Переслал счёт\./);
    assert.match(plain, /Счёт во вложении\./);
  });

  it('keeps a Finnish forward with its note intact (#647 review 2)', () => {
    const fwd = aiMessageText({ text: 'Katso alta.\n\n---------- Välitetty viesti ---------\n'
      + 'Lähettäjä: Anna\nLähetetty: lauantai 18. lokakuuta 2026 klo 21.14\nAihe: Lasku 42\n\nTässä lasku.' });
    assert.match(fwd, /Katso alta\./);
    assert.match(fwd, /Tässä lasku\./);
  });

  it('keeps an Outlook forward: a note, then a header block with no marker (#647 review)', () => {
    const html = '<p>Forwarding this to you.</p>'
      + '<div id="divRplyFwdMsg"><hr />'
      + '<p><b>From:</b> Daniil &lt;d@example.com&gt;<br /><b>Sent:</b> Mon, Oct 19, 2026 10:00<br />'
      + '<b>To:</b> Anna &lt;a@example.com&gt;<br /><b>Subject:</b> Invoice 42</p></div>'
      + '<p>The invoice is attached. Please pay before Friday.</p>';
    const out = aiMessageText({ html }, { subject: 'Fwd: Invoice 42' });
    assert.match(out, /Forwarding this to you\./);
    assert.match(out, /pay before Friday/);
    // The envelope subject wins even when the forwarded mail was itself a reply (Re: …).
    const forwardedReply = stripQuotedHistory(
      'Forwarding this.\nFrom: D\nSent: Mon, Oct 19, 2026\nSubject: Re: invoice\n\nThe body.',
      { subject: 'Fwd: Re: invoice' });
    assert.match(forwardedReply, /The body\./);
  });

  it('keeps a forward marked in an unknown language: a gmail_quote with no blockquote inside (#647 review)', () => {
    const html = '<div dir="ltr">See this.</div>'
      + '<div class="gmail_quote">---------- 전달된 메일 ----------<br />'
      + '보낸사람: Anna &lt;anna@example.com&gt;<br />날짜: 2026년 10월 18일<br />제목: Invoice 42<br /><br />'
      + '<div dir="ltr">Invoice attached, please pay.</div></div>';
    const out = aiMessageText({ html });
    assert.match(out, /See this\./);
    assert.match(out, /Invoice attached, please pay\./);
  });

  it('keeps an Apple forward marked in German: the wrapper opens with a header run (#647 review)', () => {
    const html = '<div>Siehe unten.</div>'
      + '<blockquote type="cite"><div>Weitergeleitete Nachricht:</div>'
      + '<div>Von: Anna &lt;anna@example.com&gt;</div><div>Datum: 18. Oktober 2026</div>'
      + '<div>Betreff: Rechnung 42</div><div>An: mich</div>'
      + '<div><br /></div><div>Die Rechnung ist angehängt.</div></blockquote>';
    const out = aiMessageText({ html });
    assert.match(out, /Siehe unten\./);
    assert.match(out, /Die Rechnung ist angehängt\./);
  });

  it('keeps a contact-form notification: a header run with a fresh subject (#647 review)', () => {
    const out = stripQuotedHistory('New submission\nFrom: website@example.com\nDate: Mon, Oct 19, 2026\n'
      + 'Subject: Contact from the site\n\nPlease get in touch with me about order 42.');
    assert.match(out, /order 42/);
  });

  it('keeps an Apple Mail forward in a language the label lists miss when the subject says Fwd: (#647 review)', () => {
    const html = '<div dir="ltr">Se nedan.</div><div dir="ltr"><br><blockquote type="cite">'
      + '<div dir="ltr">Vidarebefordrat brev:</div><br class="Apple-interchange-newline">'
      + '<div><b>Från: </b>Anna &lt;anna@example.com&gt;</div><div><b>Ämne: </b>Faktura 42</div>'
      + '<div><b>Datum: </b>18 oktober 2026 21:14:00 CEST</div><div><b>Till: </b>me@example.com</div>'
      + '<br><div dir="ltr">Fakturan är bifogad, betala före fredag.</div></blockquote></div>';
    const out = aiMessageText({ html }, { subject: 'Fwd: Faktura 42' });
    assert.match(out, /Se nedan\./);
    assert.match(out, /betala före fredag/);
  });

  it('keeps the body under a header block that does not quote this thread (#647 review)', () => {
    // A plain-text list digest whose first message happens to be a reply.
    const digest = "Today's Topics:\n\n   1. Re: Build fails on ARM (John Doe)\n\n"
      + '----------------------------------------------------------------------\n\n'
      + 'Message: 1\nDate: Mon, 19 Oct 2026 10:00:00 +0000\nFrom: John Doe <john@example.org>\n'
      + 'To: foo-users@lists.example.org\nSubject: Re: [Foo-users] Build fails on ARM\n\n'
      + 'Pinning the compiler to version 12 fixes the ARM build.';
    assert.match(stripQuotedHistory(digest, { subject: 'Foo-users Digest, Vol 42, Issue 7' }), /Pinning the compiler/);
    // A contact form whose visitor typed a Re: subject.
    const form = 'New submission\nFrom: website@example.com\nDate: Mon, Oct 19, 2026\nSubject: Re: my order\n\n'
      + 'My order 42 never arrived, please refund it.';
    assert.match(stripQuotedHistory(form, { subject: 'New form submission' }), /please refund it/);
  });

  it('cuts a header block that quotes this thread, with or without Re: on its own Subject (#647 review)', () => {
    const quote = quotedSubject => 'Thanks, I will pay it on Friday.\n\nFrom: Anna\n'
      + `Sent: Monday, October 19, 2026 10:00 AM\nTo: Bob\nSubject: ${quotedSubject}\n\nHi Bob, invoice 42 is attached.`;
    // A first reply quotes the thread's first mail, which had no prefix yet.
    assert.equal(stripQuotedHistory(quote('Invoice 42'), { subject: 'RE: Invoice 42' }).trim(), 'Thanks, I will pay it on Friday.');
    // A reply to a forward quotes the forward.
    assert.equal(stripQuotedHistory(quote('FW: Invoice 42'), { subject: 'RE: FW: Invoice 42' }).trim(), 'Thanks, I will pay it on Friday.');
  });

  it('cuts an Outlook-style localized header quote after real content, keeps the signature above it', () => {
    const html = '<p>Hello Daniil,</p><p>Thanks — the case is closed.</p>'
      + '<p>Jim, ASUS Tekninen tuki</p>'
      + '<p><b>Lähettäjä:</b>Daniil Sugonyaev<br /><b>Lähetetty</b><b>:</b>2026-10-16 17:57:42.409<br />'
      + '<b>Aihe</b><b>:</b>Re:Re:Re:Vivo PC GX10<br /><br />Hello Jim, here is the previous message.</p>';
    const out = aiMessageText({ html });
    assert.match(out, /case is closed/);
    assert.match(out, /Jim, ASUS Tekninen tuki/);
    assert.doesNotMatch(out, /previous message/);
  });

  it('needs a full header run (From + Sent/Date + Subject) to cut (#647 review 5)', () => {
    // From + To + Date, no Subject: a structured shipping notice, not a quote header.
    const kept = stripQuotedHistory('Booking confirmed.\nFrom: Berlin\nTo: Paris\nDate: 12 Nov 2026\n\nDeparture 08:40, gate B2.');
    assert.match(kept, /Departure 08:40, gate B2\./);
    // From + Sent + Subject: an Outlook-style quote header; the unprefixed body below still cuts.
    const cut = stripQuotedHistory('My answer.\nFrom: X Y\nSent: Mon, Oct 19, 2026 at 10:00 AM\nSubject: Re: hi\n\nquoted body');
    assert.equal(cut, 'My answer.');
  });

  it('cuts an "On … wrote:" attribution when the quote below is marked, not prose or a bare body', () => {
    const cut = stripQuotedHistory('My answer.\nOn Mon, Oct 19, 2026 at 8:27 AM X <x@y.z> wrote:\n> Old body');
    assert.equal(cut, 'My answer.');
    const cutRu = stripQuotedHistory('Мой ответ.\n19 окт. 2026 г., 15:53 пользователь X написал:\n> Старое письмо');
    assert.equal(cutRu, 'Мой ответ.');
    const keptProse = stripQuotedHistory('Please focus on what the author wrote:\nMore of my own text.');
    assert.match(keptProse, /More of my own text/);
    // Prose ending in "wrote:" never starts a cut itself, but a `>`-quoted block under it
    // is still trailing history and still cuts at its first quoted line (#647 review).
    const cutUnderProse = stripQuotedHistory('Focus on what the author wrote:\n> Simplicity is key');
    assert.equal(cutUnderProse, 'Focus on what the author wrote:');
    // Thunderbird-style unprefixed quote: cutting could eat the reader's own continuation.
    const keptBare = stripQuotedHistory('My answer.\nOn Mon, Oct 19, 2026 at 8:27 AM X <x@y.z> wrote:\nOld body without markers');
    assert.match(keptBare, /Old body without markers/);
  });

  it('cuts >-quoted lines, but keeps an inline answer that continues below a quote (#647 review 4)', () => {
    const out = aiMessageText({ text: 'My answer.\n> Old line one\n> Old line two' });
    assert.equal(out, 'My answer.');
    const inline = stripQuotedHistory('Answer part one.\n> quoted line\nAnswer part two.');
    assert.match(inline, /Answer part one\./);
    assert.match(inline, /quoted line/);
    assert.match(inline, /Answer part two\./);
  });

  it('keeps a newsletter pull-quote: a mid-document blockquote with text after it (#647 review 6)', () => {
    const out = aiMessageText({ html: '<p>Our readers say:</p><blockquote><p>Best tool of the year.</p></blockquote>'
      + '<p>Subscribe at the link below.</p>' });
    assert.match(out, /Our readers say:/);
    assert.match(out, /Best tool of the year\./);
    assert.match(out, /Subscribe at the link below\./);
  });

  it('drops bare URLs and [image:] placeholders, keeps the words around them', () => {
    const out = aiMessageText({ html: '<p>See <a href="https://www.asus.com/fi/support/">ASUS Support</a>'
      + ' or https://example.com/track?x=1 and <https://example.com/2></p><p>[image: Banner]</p>' });
    assert.equal(out, 'See ASUS Support or and');
  });

  it('custom actions ({ full: true }) keep quoted history and links; built-ins get neither', () => {
    const body = { text: 'Yes.\n> the original request, see https://example.com/t/42' };
    assert.equal(aiMessageText(body), 'Yes.');
    const full = aiMessageText(body, { full: true });
    assert.match(full, /the original request/);
    assert.match(full, /https:\/\/example\.com\/t\/42/);
    const fullHtml = aiMessageText({ html: '<p>Note</p><blockquote><p>Old</p></blockquote>' }, { full: true });
    assert.match(fullHtml, /Old/);
  });

  it('full mode keeps an anchor target beside its words; a mailto equal to its label adds nothing (#647 review)', () => {
    const html = '<p>See <a href="https://example.com/agenda?id=42">the agenda</a> and write to '
      + '<a href="mailto:team@example.com">team@example.com</a>.</p>';
    const full = aiMessageText({ html }, { full: true });
    assert.match(full, /the agenda \(https:\/\/example\.com\/agenda\?id=42\)/);
    assert.doesNotMatch(full, /mailto:/);
    assert.equal(aiMessageText({ html }), 'See the agenda and write to team@example.com.');
  });

  it('full mode drops an anchor that has no words — an image link leaves no bare target (#647 review)', () => {
    const html = '<p><a href="https://example.com/banner"><img src="banner.png" alt="Banner"></a></p>'
      + '<p>See <a href="https://example.com/agenda">the agenda</a>.</p>';
    const full = aiMessageText({ html }, { full: true });
    assert.doesNotMatch(full, /\(https:\/\/example\.com\/banner\)/);
    assert.match(full, /the agenda \(https:\/\/example\.com\/agenda\)/);
  });

  it('keeps a quote that a signature follows: real text below means it is not the tail (#647 review)', () => {
    const out = stripQuotedHistory('My answer.\n> the quoted request\n-- \nDaniil');
    assert.match(out, /My answer\./);
    assert.match(out, /the quoted request/);
    assert.match(out, /Daniil/);
  });

  it('prefers a real text/plain part, and still cuts its quoted history', () => {
    const out = aiMessageText({ text: 'My answer.\n> quoted', html: '<p>Ignored HTML</p>' });
    assert.equal(out, 'My answer.');
  });

  it('parses a text/plain part that is really HTML, and prefers the HTML part over it', () => {
    assert.match(aiMessageText({ text: '<p>Hello</p><div>x</div><b>y</b><i>z</i>' }), /Hello/);
    assert.equal(aiMessageText({ text: '<p>Not rendered</p><div>a</div><b>b</b><i>c</i>', html: '<p>Rendered</p>' }), 'Rendered');
  });

  it('sends a text/plain part as written when it only mentions a tag (#647 review)', () => {
    const out = aiMessageText({ text: 'My page breaks when I use <img src="logo.png" width="10"> inside a flex box.' });
    assert.match(out, /<img src="logo\.png" width="10"> inside a flex box/);
  });

  it('keeps a plain-text table\'s column spacing, while HTML extraction still collapses runs (#647 review)', () => {
    const table = 'col a    col b\nfoo      bar';
    assert.ok(aiMessageText({ text: table }).includes(table));
    assert.equal(aiMessageText({ html: '<p>spaced    out</p>' }), 'spaced out');
  });

  it('keeps a body that only pastes a header block at the top', () => {
    const out = stripQuotedHistory('From: postmaster@example.com\nTo: me@example.com\nSubject: Delivery report\n\nYour message could not be delivered.');
    assert.match(out, /could not be delivered/);
  });

  it('keeps a body that is nothing but a quote (a cut would leave nothing)', () => {
    const out = stripQuotedHistory('On Mon, Oct 19, 2026 at 8:27 AM X <x@y.z> wrote:\nOnly the quoted part.');
    assert.match(out, /Only the quoted part/);
  });

  it('drops zero-width filler and collapses whitespace to lines and paragraphs', () => {
    const out = aiMessageText({ html: '<p>Text\u200b more</p><p></p><p>Second</p>' });
    assert.equal(out, 'Text more\n\nSecond');
  });

  it('handles empty and missing bodies', () => {
    assert.equal(aiMessageText(null), '');
    assert.equal(aiMessageText({}), '');
    assert.equal(aiMessageText({ text: '', html: '' }), '');
  });

  it('stays linear: ~120 KB of quotes with a signature after them still reads whole (#647 review)', () => {
    const time = (fn) => {
      const started = performance.now();
      fn();
      return performance.now() - started;
    };
    const repeated = '> q\n'.repeat(30000);
    let out;
    const textElapsed = time(() => { out = stripQuotedHistory(`Hi\n${repeated}Sent from my phone`); });
    assert.match(out, /^Hi\n/);
    assert.match(out, /Sent from my phone$/);
    assert.equal(stripQuotedHistory(`My answer.\n${repeated}`), 'My answer.');

    const html = `<p>Hi</p>${'&gt; q<br>'.repeat(30000)}<div>Sent from my phone</div>`;
    let outHtml;
    const htmlElapsed = time(() => { outHtml = aiMessageText({ html }); });
    assert.match(outHtml, /Hi/);
    assert.match(outHtml, /Sent from my phone/);

    // Against the same amount of unquoted text on the same machine, not a fixed time: a busy
    // CI runner is several times slower across the board. The per-quote scans this replaces
    // took ~8 s at 100 KB in Node, hundreds of times the plain text.
    const plainText = time(() => stripQuotedHistory(`Hi\n${'- q\n'.repeat(30000)}Sent from my phone`));
    const plainHtml = time(() => aiMessageText({ html: `<p>Hi</p>${'&amp; q<br>'.repeat(30000)}<div>Sent from my phone</div>` }));
    assert.ok(textElapsed < plainText * 10 + 200, `text pass took ${textElapsed.toFixed(0)}ms, plain ${plainText.toFixed(0)}ms`);
    assert.ok(htmlElapsed < plainHtml * 10 + 200, `html pass took ${htmlElapsed.toFixed(0)}ms, plain ${plainHtml.toFixed(0)}ms`);
  });

  it('degrades to tags-to-spaces on a tree too deep for the DOM walk, instead of dying (#647 review)', () => {
    // jsdom's parse is slow past a few thousand nested nodes and the walk's recursion
    // throws a RangeError around 6,000 — the cheapest depth that reaches the fallback.
    const deep = '<div>'.repeat(6000) + 'deep leaf' + '</div>'.repeat(6000);
    assert.match(aiMessageText({ html: deep }), /deep leaf/);
  });
});
