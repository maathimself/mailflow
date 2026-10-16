// Render test for the email frame: what its document says when a body is shown dark or as sent.

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
const { default: MessageBodyView, frameSurface } = await import('./MessageBodyView.jsx');

const BODY = { html: '<style>.a{color:#111}</style><p class="a">Hi</p>', darkCss: '@media (min-width: 0px){.a{color:#eee}}' };

let root;
before(() => { root = createRoot(document.getElementById('root')); });
after(async () => { await React.act(async () => root.unmount()); });

const frameDoc = async (props) => {
  const iframeRef = React.createRef();
  await React.act(async () => {
    root.render(React.createElement(MessageBodyView, {
      body: BODY, messageId: 'm1', emailScaleRef: { current: 1 },
      hasNativeContextTarget: false, onContextMenu: null, iframeRef, ...props,
    }));
  });
  return document.querySelector('iframe').getAttribute('srcdoc');
};
const setVar = (name, value) => document.documentElement.style.setProperty(name, value);

describe('the email frame (#228)', () => {
  // The document always renders the email as sent; showing it dark switches styles in place
  // (utils/darkBody.js), so these are all present from the start.
  const styleOf = (doc, id) => new RegExp(`<style id="${id}"( media="not all")?>([\\s\\S]*?)</style>`).exec(doc);

  test("as sent: forced light, with the dark styles and the sender's dark CSS switched off", async () => {
    const doc = await frameDoc({ dark: false });
    assert.match(doc, /<meta name="color-scheme" content="only light">/);
    const light = styleOf(doc, 'mf-frame-light');
    assert.equal(light[1], undefined, 'the light styles are on');
    assert.match(light[2], /background-color: #ffffff !important; color-scheme: light;/);
    assert.equal(styleOf(doc, 'mf-frame-dark')[1], ' media="not all"');
    const sender = styleOf(doc, 'mf-sender-dark');
    assert.equal(sender[1], ' media="not all"');
    assert.equal(sender[2], '@media (min-width: 0px){.a{color:#eee}}');
  });

  test("the theme's colors go into MailFlow's dark styles, then the sender's dark CSS so it can override them", async () => {
    setVar('--bg-primary', '#101820'); setVar('--text-primary', '#e0e6ee'); setVar('--accent', '#7c6af7');
    const doc = await frameDoc({ dark: true });
    const dark = styleOf(doc, 'mf-frame-dark')[2];
    assert.match(dark, /background-color: #101820; color-scheme: dark;/, 'not !important, so the sender can set it');
    assert.match(dark, /color: #e0e6ee;/);
    assert.match(dark, /a \{ color: #7c6af7; \}/);
    const order = ['mf-frame-light', 'mf-frame-dark', 'mf-sender-dark'].map(id => doc.indexOf(`<style id="${id}"`));
    assert.ok(doc.indexOf('pre, code {') < order[0] && order[0] < order[1] && order[1] < order[2],
      "MailFlow's styles, then its light and dark colors, then the sender's dark CSS");
    assert.ok(doc.indexOf('<p class="a">Hi</p>') < order[0], 'all after the email');
  });

  test('switching dark on or off does not reload the frame', async () => {
    const off = await frameDoc({ dark: false });
    const on = await frameDoc({ dark: true });
    assert.equal(on, off);
  });

  // Marking the message read gives it a new identity, and the pane a new onContextMenu. That
  // must not tear the frame's setup down and run it again (its cleanup resets the scale).
  test('a new context-menu callback does not set the frame up again', async () => {
    const emailScaleRef = { current: 1 };
    const iframeRef = React.createRef();
    await frameDoc({ emailScaleRef, iframeRef, onContextMenu: () => {} });
    emailScaleRef.current = 0.6; // as scaling a wide email would leave it
    await frameDoc({ emailScaleRef, iframeRef, onContextMenu: () => {}, hasNativeContextTarget: () => false });
    assert.equal(emailScaleRef.current, 0.6);
  });

  test('a theme color that is not a plain color is not written into the frame', async () => {
    setVar('--bg-primary', 'red;}</style><p>injected');
    const doc = await frameDoc({ dark: true });
    assert.doesNotMatch(doc, /injected/);
    assert.match(styleOf(doc, 'mf-frame-dark')[2], /background-color: #0f0f11;/, 'falls back to the default dark background');
    setVar('--bg-primary', '#101820');
  });

  test("dark CSS that could close its style element is left out", async () => {
    const doc = await frameDoc({ dark: true, body: { html: '<p>x</p>', darkCss: 'p{color:#eee}</style><p>injected' } });
    assert.doesNotMatch(doc, /injected/);
    assert.equal(styleOf(doc, 'mf-sender-dark')[2], '');
  });
});

// The browser paints the frame on its own schedule, which could be before the dark pass had run:
// the email showed light, then turned dark a moment later.
describe('no light flash before the dark pass', () => {
  const tick = () => new Promise(r => setTimeout(r, 0));
  const show = async (props) => {
    const iframeRef = React.createRef();
    const seen = [];
    await React.act(async () => root.render(null)); // a fresh frame, with no document of ours in it
    await React.act(async () => {
      root.render(React.createElement(MessageBodyView, {
        body: { html: `<p>${props.messageId}</p>`, darkCss: '' }, emailScaleRef: { current: 1 },
        hasNativeContextTarget: false, onContextMenu: null, iframeRef,
        onDarkResult: () => seen.push(iframeRef.current.style.visibility), ...props,
      }));
    });
    return { iframe: iframeRef.current, seen };
  };
  // What the frame's document looks like once the email has been parsed into it.
  const parse = (iframe, key = /data-mf-doc="(\d+)"/.exec(iframe.getAttribute('srcdoc'))[1]) => {
    const doc = iframe.contentDocument;
    doc.getElementById('mf-scale-wrapper')?.remove();
    const wrapper = doc.createElement('div');
    wrapper.id = 'mf-scale-wrapper';
    wrapper.setAttribute('data-mf-doc', key);
    wrapper.innerHTML = '<p>Hi</p>';
    doc.body.appendChild(wrapper);
  };

  test('a dark reader\'s frame stays hidden until the dark pass has run, then shows', async () => {
    const { iframe, seen } = await show({ dark: true, messageId: 'flash-1' });
    assert.equal(iframe.style.visibility, 'hidden', 'hidden before the document is ready');
    parse(iframe);
    for (let i = 0; i < 5 && iframe.style.visibility; i += 1) await tick();
    assert.deepEqual(seen, ['hidden'], 'the dark pass ran while it was hidden');
    assert.equal(iframe.style.visibility, '', 'shown once it had');
  });

  // Until the swap lands, the frame still holds the previous email's document. Taken for the new
  // one, it was set up instead, and the new email showed light until its load event.
  test("the previous email's document is not taken for the next one", async () => {
    const { iframe, seen } = await show({ dark: true, messageId: 'flash-4' });
    const first = /data-mf-doc="(\d+)"/.exec(iframe.getAttribute('srcdoc'))[1];
    await React.act(async () => {
      root.render(React.createElement(MessageBodyView, {
        body: { html: '<p>next</p>', darkCss: '' }, emailScaleRef: { current: 1 }, messageId: 'flash-5',
        hasNativeContextTarget: false, onContextMenu: null, iframeRef: { current: iframe }, dark: true,
        onDarkResult: () => seen.push(iframe.style.visibility),
      }));
    });
    parse(iframe, first); // the frame still shows the first email
    for (let i = 0; i < 5; i += 1) await tick();
    assert.deepEqual(seen, [], 'nothing set up against the old document');
    assert.equal(iframe.style.visibility, 'hidden', 'still hidden, waiting for the new one');
    parse(iframe); // the new email arrives
    for (let i = 0; i < 5 && iframe.style.visibility; i += 1) await tick();
    assert.deepEqual(seen, ['hidden']);
    assert.equal(iframe.style.visibility, '');
  });

  test('a light reader\'s frame is never hidden', async () => {
    const { iframe } = await show({ dark: false, messageId: 'flash-2' });
    assert.equal(iframe.style.visibility, '');
  });

  test('a frame whose document never turns up is shown anyway', async () => {
    const { iframe } = await show({ dark: true, messageId: 'flash-3' });
    assert.equal(iframe.style.visibility, 'hidden');
    for (let i = 0; i < 400 && iframe.style.visibility; i += 1) await tick();
    assert.equal(iframe.style.visibility, '');
  });
});

// The card around a dark body takes the background the body actually shows, so a sender's own
// dark background does not sit in a strip of the theme's.
describe('frameSurface', () => {
  const docWith = (css) => new JSDOM(`<!DOCTYPE html><html><head><style>${css}</style></head><body><p>x</p></body></html>`).window.document;

  test("reads the sender's body background, then the root's", () => {
    assert.equal(frameSurface(docWith('body{background:#121212}')), 'rgb(18, 18, 18)');
    assert.equal(frameSurface(docWith('html{background-color:#202020}')), 'rgb(32, 32, 32)');
  });

  test('gives nothing when neither sets a visible background', () => {
    assert.equal(frameSurface(docWith('p{color:red}')), null);
    assert.equal(frameSurface(docWith('body{background:rgba(0,0,0,0)}')), null);
    assert.equal(frameSurface(null), null);
  });
});
