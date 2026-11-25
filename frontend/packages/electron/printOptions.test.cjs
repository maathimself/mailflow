const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizePrintOptions, pageRanges, pdfOptions, printerOptions } = require('./printOptions.cjs');

test('page ranges use inclusive, zero-based indices for native printing', () => {
  assert.deepEqual(pageRanges(' 1-3, 5, 7-10 '), [{ from: 0, to: 2 }, { from: 4, to: 4 }, { from: 6, to: 9 }]);
  assert.deepEqual(pageRanges(''), []);
  assert.deepEqual(pageRanges('5, 2-4, 1, 3'), [{ from: 0, to: 4 }]);
  for (const value of ['0', '-1', '3-1', '1.5', '1,', 'abc', '1-100001', {}]) {
    assert.throws(() => pageRanges(value), /valid page/);
  }
});

test('PDF export and printer options preserve settings and convert margin units', () => {
  const options = normalizePrintOptions({
    deviceName: 'system-printer-id', copies: 3, pageSize: 'A4', landscape: true,
    marginMode: 'custom', customMargin: 0.5, headers: true, printBackground: true, pages: '2-4',
  });
  const pdf = pdfOptions(options, true), printer = printerOptions(options);
  assert.equal(pdf.margins.top, 0.5, 'PDF margins use inches');
  assert.equal(printer.margins.top, 48, 'native margins use CSS pixels');
  assert.equal(pdf.pageRanges, '2-4');
  assert.deepEqual(printer.pageRanges, [{ from: 1, to: 3 }]);
  assert.equal(pdfOptions(options).pageRanges, undefined, 'preview contains all pages for navigation');
  for (const result of [pdf, printer]) {
    assert.equal(result.pageSize, 'A4');
    assert.equal(result.landscape, true);
    assert.equal(result.printBackground, true);
  }
  assert.equal(printer.copies, 3);
  assert.equal(printer.deviceName, 'system-printer-id');
  assert.equal(printer.silent, true);
  assert.equal(printerOptions(options, true).silent, false);
});

test('invalid settings fail before reaching the OS or PDF generator', () => {
  for (const raw of [null, { copies: 0 }, { copies: 1000 }, { copies: 1.1 }, { pageSize: 'unknown' },
    { marginMode: 'other' }, { marginMode: 'custom', customMargin: -1 }, { marginMode: 'custom', customMargin: NaN },
    { marginMode: 'custom', customMargin: 3 }, { pages: '0-2' }]) {
    assert.throws(() => normalizePrintOptions(raw));
  }
  assert.equal(normalizePrintOptions({ marginMode: 'none' }).margin, 0);
  assert.equal(normalizePrintOptions({ marginMode: 'minimum' }).margin, 0.25);
});
