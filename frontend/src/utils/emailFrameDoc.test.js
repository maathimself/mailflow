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
