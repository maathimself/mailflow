// Render test for the email frame's Content-Security-Policy: a body served with remote images
// blocked may load no remote image, font or media, whatever its HTML still references.

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
        'export const useTranslation = () => ({ t: (k) => k, i18n: { language: "en", changeLanguage: () => {} } });',
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
  window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
  CustomEvent: dom.window.CustomEvent, Node: dom.window.Node, Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement, getComputedStyle: dom.window.getComputedStyle,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
dom.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.requestAnimationFrame ??= cb => setTimeout(() => cb(Date.now()), 0);
globalThis.cancelAnimationFrame ??= id => clearTimeout(id);
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: MessageBodyView } = await import('./MessageBodyView.jsx');

let root;
before(() => { root = createRoot(document.getElementById('root')); });
after(async () => { await React.act(async () => root.unmount()); });

const frameDoc = async (body) => {
  const iframeRef = React.createRef();
  await React.act(async () => {
    root.render(React.createElement(MessageBodyView, {
      body, messageId: 'm1', emailScaleRef: { current: 1 },
      hasNativeContextTarget: false, onContextMenu: null, iframeRef,
    }));
  });
  return document.querySelector('iframe').getAttribute('srcdoc');
};
const csp = (doc) => /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(doc)[1];

describe('the email frame and blocked remote images', () => {
  test('forbids remote images, fonts and media when the body was served blocked', async () => {
    const policy = csp(await frameDoc({ html: '<p>x</p>', remoteImagesBlocked: true }));
    assert.match(policy, /img-src data: blob:;/);
    assert.match(policy, /font-src data:;/);
    assert.match(policy, /media-src data: blob:;/);
    assert.match(policy, /^script-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; style-src 'unsafe-inline';/, 'the rest unchanged');
  });

  test('loads images from MailFlow alone when they come through the image proxy', async () => {
    const policy = csp(await frameDoc({ html: '<p>x</p>', remoteImagesProxied: true }));
    // MailFlow's origin named too: Firefox does not count it as 'self' in a srcdoc frame.
    assert.match(policy, /img-src 'self' https:\/\/mail\.example\.invalid data: blob:;/);
    assert.match(policy, /font-src data:;/);
  });

  test('leaves images to the email when they are allowed', async () => {
    for (const body of [{ html: '<p>x</p>', remoteImagesBlocked: false }, { html: '<p>x</p>' }]) {
      assert.doesNotMatch(csp(await frameDoc(body)), /img-src|font-src|media-src/);
    }
  });
});
