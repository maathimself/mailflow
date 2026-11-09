import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) {
      return { format: 'module', shortCircuit: true, source: 'export const useTranslation = () => ({ t: key => key });' };
    }
    if (url.endsWith('.jsx')) {
      const source = transform(readFileSync(new URL(url), 'utf8'), { transforms: ['jsx'], jsxRuntime: 'automatic', filePath: url }).code;
      return { format: 'module', shortCircuit: true, source };
    }
    if (url.endsWith('/utils/api.js')) {
      return { format: 'module', shortCircuit: true, source: `export const api = { getMessageHeaders: async () => ({ headers: 'From: sender@example.test\\nX-Custom-Trace: example' }) };` };
    }
    return nextLoad(url, context);
  },
});

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.test' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
dom.window.matchMedia = () => ({ addEventListener() {}, removeEventListener() {} });
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const MessageHeaderModal = (await import('./MessageHeaderModal.jsx')).default;

for (const width of [375, 1024]) {
  test(`header labels are equally readable at ${width}px`, async () => {
    window.innerWidth = width;
    const root = createRoot(document.getElementById('root'));
    await React.act(async () => { root.render(React.createElement(MessageHeaderModal, { messageId: 'fixture', onClose() {} })); });
    const labels = [...document.querySelectorAll(width < 768 ? 'div' : 'td')];
    const from = labels.find(el => el.textContent === 'From');
    const custom = labels.find(el => el.textContent === 'X-Custom-Trace');
    assert.ok(from && custom, 'both header names are visible');
    assert.equal(custom.style.color, from.style.color);
    assert.equal(custom.style.fontWeight, from.style.fontWeight);
    await React.act(async () => root.unmount());
  });
}
