import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { buildFrameDoc, WIDE_TABLE_ATTR } from './emailFrameDoc.js';

const frame = (html) => {
  const { document } = new JSDOM(buildFrameDoc({ html })).window;
  return { document, width: el => document.defaultView.getComputedStyle(el).width };
};

describe('buildFrameDoc: top-level tables (#757)', () => {
  test('a top-level table keeps its own width: not stretched to the frame', () => {
    const { document, width } = frame('<table width="878" align="center"><tr><td>GLS</td></tr></table>');
    assert.notEqual(width(document.querySelector('table')), '100%');
  });

  test('one the fit marked as wider than the frame is narrowed to it, also under a center or div', () => {
    const { document, width } = frame(
      `<table ${WIDE_TABLE_ATTR}><tr><td>a</td></tr></table>`
      + `<center><div><table ${WIDE_TABLE_ATTR}><tr><td>b</td></tr></table></div></center>`);
    for (const t of document.querySelectorAll('table')) assert.equal(width(t), '100%');
  });

  test('a nested table is never narrowed by the frame', () => {
    const { document, width } = frame(`<table><tr><td><table ${WIDE_TABLE_ATTR}><tr><td>x</td></tr></table></td></tr></table>`);
    assert.notEqual(width(document.querySelectorAll('table')[1]), '100%');
  });
});

describe('buildFrameDoc: trimmed quoted history', () => {
  const REPLY = '<div>Yes</div><div class="gmail_quote"><div class="gmail_attr">On 5 Jan 2026, Ana wrote:</div><blockquote>Lunch?</blockquote></div>';
  const LABELS = { show: 'Show trimmed content', hide: 'Hide trimmed content' };
  globalThis.document ??= new JSDOM('').window.document;

  test('with labels, the quote is folded into a closed toggle, no script needed', () => {
    const doc = buildFrameDoc({ html: REPLY, trimLabels: LABELS });
    const { document } = new JSDOM(doc).window;
    const details = document.querySelector('#mf-scale-wrapper details.mf-trimmed');
    assert.ok(details, 'the quote sits in a <details>');
    assert.equal(details.open, false);
    assert.match(details.textContent, /Lunch\?/);
    assert.equal(details.querySelector('summary .mf-trimmed-show').title, 'Show trimmed content');
    assert.match(doc, /script-src 'none'/);
  });

  test('the frame\'s CSS shows the title that applies, for the toggle closed and open', () => {
    const { document } = new JSDOM(buildFrameDoc({ html: REPLY, trimLabels: LABELS })).window;
    const shown = cls => document.defaultView.getComputedStyle(document.querySelector(`.${cls}`)).display !== 'none';
    assert.deepEqual([shown('mf-trimmed-show'), shown('mf-trimmed-hide')], [true, false]);
    document.querySelector('details').open = true;
    assert.deepEqual([shown('mf-trimmed-show'), shown('mf-trimmed-hide')], [false, true]);
  });

  test('without labels the email is shown whole, as sent', () => {
    const { document } = new JSDOM(buildFrameDoc({ html: REPLY })).window;
    assert.equal(document.querySelector('details'), null);
    assert.equal(document.getElementById('mf-scale-wrapper').innerHTML, REPLY);
  });
});
