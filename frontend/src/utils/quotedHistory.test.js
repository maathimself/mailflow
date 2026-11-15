import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { trimQuotedHtml, splitQuotedText, isForwardSubject } from './quotedHistory.js';

const { document } = new JSDOM('').window;
const LABELS = { show: 'Show trimmed content', hide: 'Hide trimmed content' };

// Text nodes one space apart, as blocks read on screen.
function words(node) {
  const walker = document.createTreeWalker(node, 4 /* NodeFilter.SHOW_TEXT */);
  const parts = [];
  while (walker.nextNode()) parts.push(walker.currentNode.nodeValue);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

// What is left on show, and what went behind the toggle; null when nothing was trimmed.
function trim(html) {
  const out = trimQuotedHtml(html, LABELS, document);
  if (out === null) return null;
  const host = document.createElement('div');
  host.innerHTML = out;
  const details = host.querySelectorAll('details.mf-trimmed');
  assert.equal(details.length, 1, 'one toggle');
  const hidden = details[0].cloneNode(true);
  hidden.querySelector('summary').remove();
  details[0].remove();
  return { shown: words(host), hidden: words(hidden) };
}

describe('trimQuotedHtml: what counts as quoted history', () => {
  test('Gmail\'s quote container, attribution and all', () => {
    assert.deepEqual(trim(
      '<div dir="ltr">Sounds good.</div><br><div class="gmail_quote gmail_quote_container">'
      + '<div dir="ltr" class="gmail_attr">On Mon, Jan 5, 2026 at 10:00 Ana &lt;a@x.z&gt; wrote:<br></div>'
      + '<blockquote class="gmail_quote">Lunch?</blockquote></div>'),
    { shown: 'Sounds good.', hidden: 'On Mon, Jan 5, 2026 at 10:00 Ana <a@x.z> wrote: Lunch?' });
  });

  test('Gmail\'s older div.gmail_quote, with the attribution as bare text', () => {
    assert.deepEqual(trim(
      '<div>Yes</div><div class="gmail_quote">On 5 Jan 2026, Ana wrote:<br><blockquote class="gmail_quote">Lunch?</blockquote></div>'),
    { shown: 'Yes', hidden: 'On 5 Jan 2026, Ana wrote: Lunch?' });
  });

  test('Apple Mail\'s blockquote type="cite", with the attribution above it', () => {
    assert.deepEqual(trim(
      '<div>Yes</div><div><br><div>On Jan 5, 2026, at 10:00, Ana &lt;a@x.z&gt; wrote:</div><br>'
      + '<blockquote type="cite"><div>Lunch?</div></blockquote></div>'),
    { shown: 'Yes', hidden: 'On Jan 5, 2026, at 10:00, Ana <a@x.z> wrote: Lunch?' });
  });

  test('Apple Mail\'s attribution inside the quote, after the sanitizer dropped type="cite"', () => {
    assert.deepEqual(trim(
      '<div>Yes</div><blockquote><div>On Jan 5, 2026, at 10:00, Ana wrote:</div><div>Lunch?</div></blockquote>'),
    { shown: 'Yes', hidden: 'On Jan 5, 2026, at 10:00, Ana wrote: Lunch?' });
  });

  test('Thunderbird\'s moz-cite-prefix and its quote', () => {
    assert.deepEqual(trim(
      '<p>Yes</p><div class="moz-cite-prefix">On 1/5/26 10:00, Ana wrote:<br></div><blockquote type="cite">Lunch?</blockquote>'),
    { shown: 'Yes', hidden: 'On 1/5/26 10:00, Ana wrote: Lunch?' });
  });

  test('Outlook\'s divRplyFwdMsg, the rule above it, and everything after it', () => {
    assert.deepEqual(trim(
      '<div class="WordSection1"><p>Yes</p><hr><div id="divRplyFwdMsg"><b>From:</b> Ana<br><b>Sent:</b> 5 January 2026</div>'
      + '<div>Lunch?</div></div><p>Earlier still</p>'),
    { shown: 'Yes', hidden: 'From: Ana Sent: 5 January 2026 Lunch? Earlier still' });
  });

  test('Outlook\'s appendonsend marker and everything after it', () => {
    assert.deepEqual(trim(
      '<div>Yes</div><div id="appendonsend"></div><hr><div><b>From:</b> Ana</div><div>Lunch?</div>'),
    { shown: 'Yes', hidden: 'From: Ana Lunch?' });
  });

  test('Yahoo\'s yahoo_quoted', () => {
    assert.deepEqual(trim(
      '<div>Yes</div><div class="yahoo_quoted"><div class="yahoo_quoted_header">On Monday, January 5, 2026, Ana wrote:</div><div>Lunch?</div></div>'),
    { shown: 'Yes', hidden: 'On Monday, January 5, 2026, Ana wrote: Lunch?' });
  });

  test('the toggle carries both titles, the one not in force hidden by the frame\'s CSS', () => {
    const host = document.createElement('div');
    host.innerHTML = trimQuotedHtml('<p>Yes</p><div class="gmail_quote"><blockquote>q</blockquote></div>', LABELS, document);
    const summary = host.querySelector('details.mf-trimmed:not([open]) > summary');
    assert.equal(summary.querySelector('.mf-trimmed-show').title, 'Show trimmed content');
    assert.equal(summary.querySelector('.mf-trimmed-hide').title, 'Hide trimmed content');
    assert.equal(summary.querySelector('.mf-trimmed-show').textContent, '•••');
  });
});

describe('trimQuotedHtml: forwards', () => {
  test('a reply whose quoted history holds an earlier forward is trimmed', () => {
    const trimmed = trim(
      '<div dir="ltr">Thanks, booked.</div><br><div class="gmail_quote gmail_quote_container">'
      + '<div dir="ltr" class="gmail_attr">On Tue, Nov 10, 2026 at 12:25 PM Ana &lt;a@x.z&gt; wrote:<br></div>'
      + '<blockquote class="gmail_quote"><div dir="ltr">See the plan below.</div><br><div class="gmail_quote">'
      + '<div dir="ltr" class="gmail_attr">---------- Forwarded message ---------<br>From: Bo &lt;bo@x.z&gt;</div>'
      + '<div>The plan</div></div></blockquote></div>');
    assert.equal(trimmed?.shown, 'Thanks, booked.');
    assert.match(trimmed.hidden, /^On Tue, Nov 10, 2026[\s\S]*Forwarded message[\s\S]*The plan$/);
  });

  test('a Gmail forward is shown whole', () => {
    assert.equal(trim(
      '<div>FYI</div><div class="gmail_quote gmail_quote_container"><div class="gmail_attr">---------- Forwarded message ---------<br>From: Ana</div>'
      + '<div>The plan</div><blockquote class="gmail_quote">Earlier</blockquote></div>'), null);
  });

  test('an Apple Mail forward is shown whole, its header above the quote or opening it', () => {
    assert.equal(trim('<div>FYI</div><div><br><div>Begin forwarded message:</div><br><blockquote type="cite"><div>From: Ana</div><div>The plan</div></blockquote></div>'), null);
    assert.equal(trim('<div>FYI</div><div><br><blockquote type="cite"><div>Begin forwarded message:</div><div>The plan</div></blockquote></div>'), null);
  });
});

describe('trimQuotedHtml: what is never trimmed', () => {
  test('a body that is nothing but the quote', () => {
    assert.equal(trim('<div class="gmail_quote"><blockquote>Lunch?</blockquote></div>'), null);
    assert.equal(trim('<style>p{color:red}</style><br><div class="yahoo_quoted">On 5 Jan 2026, Ana wrote: Lunch?</div>'), null);
  });

  test('a quote with the reply below it', () => {
    assert.equal(trim('<div class="gmail_quote"><blockquote>Lunch?</blockquote></div><div>Yes, at noon</div>'), null);
    assert.equal(trim('<blockquote type="cite">Lunch?</blockquote><p>Yes</p>'), null);
  });

  test('a reply written between Gmail\'s quoted lines', () => {
    assert.equal(trim(
      '<div>See below</div><div class="gmail_quote"><blockquote>Lunch?</blockquote><div>Yes</div><blockquote>Where?</blockquote></div>'), null);
  });

  test('a passage the sender quoted, with no attribution and no type="cite"', () => {
    assert.equal(trim('<p>As the docs put it:</p><blockquote>Always back up.</blockquote>'), null);
  });

  test('an email with no quote', () => {
    assert.equal(trim('<p>Hello</p>'), null);
  });
});

describe('splitQuotedText', () => {
  test('trailing "> " lines and their attribution', () => {
    assert.deepEqual(splitQuotedText('Yes\n\nOn Mon, Jan 5, 2026 at 10:00 Ana <a@x.z> wrote:\n> Lunch?\n>\n> Ana\n'),
      { body: 'Yes', quoted: 'On Mon, Jan 5, 2026 at 10:00 Ana <a@x.z> wrote:\n> Lunch?\n>\n> Ana' });
  });

  test('an attribution wrapped onto two lines', () => {
    assert.deepEqual(splitQuotedText('Yes\n\nOn Mon, Jan 5, 2026 at 10:00 AM Ana Example <\nana@example.com> wrote:\n\n> Lunch?'),
      { body: 'Yes', quoted: 'On Mon, Jan 5, 2026 at 10:00 AM Ana Example <\nana@example.com> wrote:\n\n> Lunch?' });
  });

  test('a quote with no attribution', () => {
    assert.deepEqual(splitQuotedText('Yes\n> Lunch?'), { body: 'Yes', quoted: '> Lunch?' });
  });

  test('a quote that holds an earlier forward', () => {
    assert.deepEqual(splitQuotedText('Thanks, booked.\n\nOn Tue, Nov 10, 2026 at 12:25 PM Ana <a@x.z> wrote:\n> See the plan below.\n>\n> ---------- Forwarded message ---------\n> From: Bo\n> The plan'),
      { body: 'Thanks, booked.', quoted: 'On Tue, Nov 10, 2026 at 12:25 PM Ana <a@x.z> wrote:\n> See the plan below.\n>\n> ---------- Forwarded message ---------\n> From: Bo\n> The plan' });
  });

  test('nothing to split: no quote, a quote in the middle, the quote alone, a forward', () => {
    assert.equal(splitQuotedText('Hello'), null);
    assert.equal(splitQuotedText('> Lunch?\nYes'), null);
    assert.equal(splitQuotedText('On 5 Jan 2026, Ana wrote:\n> Lunch?'), null);
    assert.equal(splitQuotedText('FYI\n\n---------- Forwarded message ---------\nFrom: Ana\n\nThe plan\n> Lunch?'), null);
    assert.equal(splitQuotedText('FYI\n\n-------- Forwarded Message --------\nSubject: Plan\n\nOn 5 Jan 2026, Ana wrote:\n> Lunch?'), null);
  });
});

test('isForwardSubject', () => {
  for (const subject of ['Fwd: Plan', 'FW: Plan', 'WG: Plan', 'TR: Plan', 'RV: Plan']) assert.ok(isForwardSubject(subject), subject);
  for (const subject of ['Re: Fwd: Plan', 'Plan', 'Forward planning', '']) assert.ok(!isForwardSubject(subject), subject);
});
