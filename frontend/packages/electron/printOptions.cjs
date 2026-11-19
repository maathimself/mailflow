const PAPER_SIZES = new Set(['Letter', 'Legal', 'A4', 'A5', 'Tabloid']);
const { printTranslator } = require('./printI18n.cjs');

function pageRanges(value = '', t = printTranslator()) {
  if (typeof value !== 'string' || value.length > 1000) throw new Error(t('invalidPages'));
  if (!value.trim()) return [];
  const ranges = value.split(',').map((part) => {
    const match = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    const from = Number(match?.[1]);
    const to = Number(match?.[2] || match?.[1]);
    if (!match || !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || to < from || to > 100000) {
      throw new Error(t('invalidPages'));
    }
    return { from: from - 1, to: to - 1 };
  }).sort((a, b) => a.from - b.from);
  return ranges.reduce((merged, range) => {
    const last = merged.at(-1);
    if (last && range.from <= last.to + 1) last.to = Math.max(last.to, range.to);
    else merged.push(range);
    return merged;
  }, []);
}

function normalizePrintOptions(raw = {}, t = printTranslator()) {
  if (!raw || typeof raw !== 'object') throw new Error(t('invalidSettings'));
  const copies = Number(raw.copies ?? 1);
  if (!Number.isInteger(copies) || copies < 1 || copies > 999) throw new Error(t('invalidCopies'));
  const mode = raw.marginMode || 'default';
  if (!['default', 'none', 'minimum', 'custom'].includes(mode)) throw new Error(t('invalidMargins'));
  const margin = mode === 'none' ? 0 : mode === 'minimum' ? 0.25 : mode === 'custom' ? Number(raw.customMargin) : 0.4;
  if (!Number.isFinite(margin) || margin < 0 || margin > 2) throw new Error(t('invalidMarginSize'));
  if (raw.pageSize && !PAPER_SIZES.has(raw.pageSize)) throw new Error(t('unsupportedPaper'));
  const ranges = pageRanges(raw.pages || '', t);
  return {
    pageSize: raw.pageSize || 'Letter', landscape: raw.landscape === true,
    printBackground: raw.printBackground === true, headers: raw.headers === true,
    selectionOnly: raw.selectionOnly === true,
    margin, copies, ranges, pages: raw.pages?.trim() || '',
    deviceName: typeof raw.deviceName === 'string' ? raw.deviceName : '',
  };
}

function pdfOptions(options, selectedPages = false, t = printTranslator()) {
  return {
    pageSize: options.pageSize, landscape: options.landscape, printBackground: options.printBackground,
    margins: { top: options.margin, bottom: options.margin, left: options.margin, right: options.margin },
    displayHeaderFooter: options.headers,
    headerTemplate: '<div style="font-size:9px;width:100%;text-align:center">MailFlow</div>',
    footerTemplate: `<div style="font-size:9px;width:100%;text-align:center">${t('printedFrom')}</div>`,
    ...(selectedPages ? { pageRanges: options.pages } : {}),
  };
}

function printerOptions(options, systemDialog = false, t = printTranslator()) {
  const margin = Math.round(options.margin * 96);
  return {
    silent: !systemDialog, deviceName: options.deviceName, copies: options.copies,
    pageSize: options.pageSize, landscape: options.landscape, printBackground: options.printBackground,
    margins: { marginType: 'custom', top: margin, bottom: margin, left: margin, right: margin },
    pageRanges: options.ranges,
    ...(options.headers ? { header: 'MailFlow', footer: t('printedFrom') } : {}),
  };
}

module.exports = { normalizePrintOptions, pageRanges, pdfOptions, printerOptions };
