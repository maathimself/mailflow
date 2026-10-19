// Render test for attaching files by dropping them on the composer.


import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) {
      return { format: 'module', shortCircuit: true, source: [
        'export const useTranslation = () => ({ t: (k, o) => (o ? `${k} ${JSON.stringify(o)}` : k), i18n: { language: "en", changeLanguage: () => {} } });',
        'export const initReactI18next = { type: "3rdParty", init: () => {} };',
        'export const Trans = ({ children }) => children ?? null;',
        'export const I18nextProvider = ({ children }) => children ?? null;',
        'export default { useTranslation, initReactI18next };',
      ].join('\n') };
    }
    if (url.endsWith('.json')) {
      return { format: 'module', shortCircuit: true, source: `export default ${readFileSync(new URL(url), 'utf8')}` };
    }
    const shimViteEnv = (code) => code.replaceAll('import.meta.env', 'globalThis.__VITE_ENV__');
    if (url.endsWith('.jsx')) {
      const out = transform(readFileSync(new URL(url), 'utf8'), { transforms: ['jsx'], jsxRuntime: 'automatic', filePath: url });
      return { format: 'module', shortCircuit: true, source: shimViteEnv(out.code) };
    }
    if (url.startsWith('file:') && url.endsWith('.js')) {
      const code = readFileSync(new URL(url), 'utf8');
      if (code.includes('import.meta.env')) return { format: 'module', shortCircuit: true, source: shimViteEnv(code) };
    }
    return nextLoad(url, context);
  },
});

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid', pretendToBeVisual: true });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document,
  localStorage: dom.window.localStorage, CustomEvent: dom.window.CustomEvent,
  Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
  getComputedStyle: dom.window.getComputedStyle, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IS_REACT_ACT_ENVIRONMENT: true,
  FileReader: dom.window.FileReader, File: dom.window.File,
});
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
dom.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const ComposeModal = (await import('./ComposeModal.jsx')).default;

let close;
before(async () => {
  // ProseMirror looks up where a drop landed; jsdom has no layout to answer with.
  document.elementFromPoint = () => null;
  useStore.setState({
    user: { id: 'u1' }, plaintextEmail: false, composing: false, composeData: null, prepareComposeSwitch: null,
    accounts: [{ id: 'acct', enabled: true, email_address: 'me@example.invalid', name: 'Me', color: '#fff' }],
  });
  useStore.getState().openCompose({ accountId: 'acct', to: ['bob@example.invalid'], cc: [], subject: 'Plan', body: '<p>Hi Bob</p>', bodyIsHtml: true });
  const root = createRoot(document.getElementById('root'));
  await React.act(async () => { root.render(React.createElement(ComposeModal)); });
  await React.act(async () => {});
  close = () => React.act(async () => root.unmount());
});
after(() => close());

// A drag event as the browser sends it. jsdom has no DataTransfer, so the event carries a stand-in.
async function drag(type, target, { types, files = [] }) {
  const event = new window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { types, files, dropEffect: 'none' } });
  await React.act(async () => { target.dispatchEvent(event); });
  // FileReader finishes on a later task.
  await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  return event;
}
const composer = () => document.querySelector('.compose-window');
const editor = () => document.querySelector('.ProseMirror').editor;
const overlayShown = () => document.body.textContent.includes('compose.dropToAttach');
const file = (name) => new window.File(['%PDF-1.4'], name, { type: 'application/pdf' });

describe('dropping files on the composer', () => {
  test('dragging files over it says they will be attached, and leaving takes that away', async () => {
    const subject = document.querySelector('input[placeholder="compose.subject"]');
    await drag('dragenter', composer(), { types: ['Files'] });
    await drag('dragenter', subject, { types: ['Files'] }); // into a child: still over the composer
    await drag('dragleave', composer(), { types: ['Files'] });
    assert.equal(overlayShown(), true, 'still over the composer');
    await drag('dragleave', subject, { types: ['Files'] });
    assert.equal(overlayShown(), false);
  });

  test('a file dropped on the body is attached, not opened or written into the message', async () => {
    await drag('dragenter', composer(), { types: ['Files'] });
    const dropped = await drag('drop', document.querySelector('.ProseMirror'), { types: ['Files'], files: [file('quote.pdf')] });
    assert.equal(dropped.defaultPrevented, true, 'the browser does not open the file in place of the app');
    assert.match(composer().textContent, /quote\.pdf/, 'it is listed as an attachment');
    assert.equal(editor().getHTML(), '<p>Hi Bob</p>', 'nothing went into the body');
    assert.equal(overlayShown(), false);
  });

  test('several files dropped at once are all attached', async () => {
    await drag('drop', composer(), { types: ['Files'], files: [file('a.pdf'), file('b.pdf')] });
    assert.match(composer().textContent, /a\.pdf/);
    assert.match(composer().textContent, /b\.pdf/);
  });

  test('dragging text is left to the editor', async () => {
    await drag('dragenter', composer(), { types: ['text/plain'] });
    assert.equal(overlayShown(), false);
    const dropped = await drag('drop', composer(), { types: ['text/plain'] });
    assert.equal(dropped.defaultPrevented, false);
  });
});
