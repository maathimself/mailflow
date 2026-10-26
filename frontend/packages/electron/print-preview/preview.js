import { getDocument, GlobalWorkerOptions } from '../../../node_modules/pdfjs-dist/build/pdf.mjs';

const pdfRoot = new URL('../../../node_modules/pdfjs-dist/', import.meta.url);
GlobalWorkerOptions.workerSrc = new URL('build/pdf.worker.mjs', pdfRoot).href;
const $ = id => document.getElementById(id);
const api = window.printPreview;
let pdf = null;
let pdfTask = null;
let currentPage = 1;
let selectedPages = [];
let renderTask = null;
let revision = 0;
let timer;
let ready = false;
let busy = false;
let hasPrinters = false;

function options() {
  return {
    deviceName: $('printer').value, pageSize: $('paper').value,
    landscape: $('orientation').value === 'landscape', copies: Number($('copies').value),
    marginMode: $('margins').value, customMargin: Number($('custom-margin').value),
    headers: $('headers').checked, printBackground: $('background').checked,
    selectionOnly: $('selection-only').checked,
    pages: document.querySelector('input[name="pagesMode"]:checked').value === 'custom' ? $('pages').value.replace(/[–—]/g, '-') : '',
  };
}

function error(message = '') {
  $('error').textContent = message;
  $('error').hidden = !message;
}

function buttons() {
  $('settings').inert = busy;
  $('save').disabled = !ready || busy;
  $('print').disabled = !ready || busy || !hasPrinters;
  $('previous').disabled = !ready || selectedPages.indexOf(currentPage) <= 0;
  $('next').disabled = !ready || selectedPages.indexOf(currentPage) >= selectedPages.length - 1;
  $('page').disabled = !ready;
}

function pageSelection(total) {
  const value = options().pages;
  if (!value.trim()) {
    if (document.querySelector('input[name="pagesMode"]:checked').value === 'custom') throw new Error('Enter the pages you want to print.');
    return Array.from({ length: total }, (_, i) => i + 1);
  }
  const pages = new Set();
  for (const part of value.split(',')) {
    const match = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    const start = Number(match?.[1]), end = Number(match?.[2] || match?.[1]);
    if (!match || start < 1 || end < start || end > total) throw new Error(`Enter pages between 1 and ${total}.`);
    for (let page = start; page <= end; page++) pages.add(page);
  }
  return [...pages].sort((a, b) => a - b);
}

let drawing = Promise.resolve();
function drawPage() {
  // PDF.js cannot render onto a canvas until the previous render is finished/canceled.
  renderTask?.cancel();
  drawing = drawing.catch(() => {}).then(async () => {
    if (!pdf || !ready) return;
    const page = await pdf.getPage(currentPage);
    const viewport = page.getViewport({ scale: 1 });
    const scale = $('zoom').value === 'fit'
      ? Math.max(0.2, ($('viewport').clientWidth - 44) / viewport.width)
      : Number($('zoom').value) * 96 / 72;
    const visible = page.getViewport({ scale });
    const ratio = window.devicePixelRatio || 1;
    const canvas = $('paper-preview');
    canvas.width = Math.ceil(visible.width * ratio);
    canvas.height = Math.ceil(visible.height * ratio);
    canvas.style.width = `${visible.width}px`;
    canvas.style.height = `${visible.height}px`;
    canvas.hidden = false;
    renderTask = page.render({ canvas, viewport: visible, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] });
    try { await renderTask.promise; } catch (err) { if (err.name !== 'RenderingCancelledException') throw err; }
    $('page').value = currentPage;
    $('page-count').textContent = `of ${pdf.numPages}`;
    buttons();
  }).catch(err => error(err.message));
  return drawing;
}

async function refresh() {
  const request = ++revision;
  ready = false;
  buttons();
  error();
  $('status').hidden = false;
  $('status').textContent = 'Preparing preview…';
  try {
    const bytes = await api.render(options());
    if (request !== revision) return;
    const task = getDocument({
      data: new Uint8Array(bytes), isEvalSupported: false, useWasm: false,
      cMapUrl: new URL('cmaps/', pdfRoot).href, cMapPacked: true,
      standardFontDataUrl: new URL('standard_fonts/', pdfRoot).href,
      wasmUrl: new URL('wasm/', pdfRoot).href,
    });
    let next;
    try { next = await task.promise; }
    catch (err) { await task.destroy(); throw err; }
    if (request !== revision) { await task.destroy(); return; }
    renderTask?.cancel();
    await drawing;
    const previous = pdfTask;
    pdfTask = task;
    pdf = next;
    await previous?.destroy();
    if (request !== revision) return;
    selectedPages = pageSelection(pdf.numPages);
    if (!selectedPages.includes(currentPage)) currentPage = selectedPages[0];
    $('page').max = pdf.numPages;
    ready = true;
    $('status').hidden = true;
    await drawPage();
  } catch (err) {
    if (request !== revision) return;
    error(err.message);
    $('status').textContent = 'Preview unavailable. Check your print settings.';
  }
  buttons();
}

async function action(kind) {
  if (!ready || busy) return;
  busy = true;
  buttons();
  error();
  try {
    if (kind === 'save') {
      await api.save(options());
    } else await api.print(options());
  } catch (err) { error(err.message); }
  finally { busy = false; buttons(); }
}

$('settings').addEventListener('submit', event => { event.preventDefault(); action('print'); });
$('settings').addEventListener('input', event => {
  if (busy) return;
  $('pages').disabled = document.querySelector('input[name="pagesMode"]:checked').value !== 'custom';
  $('custom-margin-row').hidden = $('margins').value !== 'custom';
  if (event.target.id === 'selection-only') {
    document.querySelector('input[name="pagesMode"][value="all"]').checked = true;
    $('pages').value = '';
    $('pages').disabled = true;
    currentPage = 1;
  }
  if (['printer', 'copies'].includes(event.target.id)) return;
  clearTimeout(timer);
  // Invalidate immediately so a pending render cannot enable Print with stale settings.
  revision++;
  ready = false;
  buttons();
  timer = setTimeout(refresh, 250);
});
$('save').addEventListener('click', () => action('save'));
for (const id of ['close', 'cancel']) $(id).addEventListener('click', () => window.close());
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') window.close();
  if ((event.ctrlKey || event.metaKey) && event.key === 'p') { event.preventDefault(); action('print'); }
});
$('previous').addEventListener('click', () => { currentPage = selectedPages[selectedPages.indexOf(currentPage) - 1] || currentPage; drawPage(); });
$('next').addEventListener('click', () => { currentPage = selectedPages[selectedPages.indexOf(currentPage) + 1] || currentPage; drawPage(); });
$('page').addEventListener('change', () => {
  if (selectedPages.includes(Number($('page').value))) { currentPage = Number($('page').value); drawPage(); }
  else $('page').value = currentPage;
});
$('zoom').addEventListener('change', drawPage);
let resizeTimer;
new ResizeObserver(() => { clearTimeout(resizeTimer); resizeTimer = setTimeout(drawPage, 100); }).observe($('viewport'));

try {
  const info = await api.load();
  if (info.accent && CSS.supports('color', info.accent)) document.documentElement.style.setProperty('--accent', info.accent);
  if (info.accentText && CSS.supports('color', info.accentText)) document.documentElement.style.setProperty('--accent-text', info.accentText);
  $('selection-only').disabled = !info.hasSelection;
  if (info.hasSelection) $('selection-label').removeAttribute('title');
  document.title = `Print Preview — ${info.title}`;
  $('printer').replaceChildren();
  hasPrinters = info.printers.length > 0;
  for (const printer of info.printers) {
    const option = new Option(printer.displayName || printer.name, printer.name, printer.isDefault, printer.isDefault);
    $('printer').add(option);
  }
  if (!hasPrinters) $('printer').add(new Option('No printers available', ''));
  await refresh();
} catch (err) {
  error(err.message);
  $('status').textContent = 'Could not load print preview.';
}
