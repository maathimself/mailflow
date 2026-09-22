import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) {
      return { format: 'module', shortCircuit: true, source: 'export const useTranslation = () => ({ t: k => k }); export default { useTranslation };' };
    }
    if (url.endsWith('.jsx')) {
      const code = readFileSync(new URL(url), 'utf8');
      return { format: 'module', shortCircuit: true, source: transform(code, { transforms: ['jsx'], jsxRuntime: 'automatic', filePath: url }).code };
    }
    return nextLoad(url, context);
  },
});

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.invalid', pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true });
const React = await import('react');
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: JevSettingsCard } = await import('./JevSettingsCard.jsx');
const { default: JevRuleTester } = await import('./JevRuleTester.jsx');
let root;
let container;
let calls;

before(() => { container = document.getElementById('root'); root = createRoot(container); });
after(async () => { await act(async () => root.unmount()); dom.window.close(); });

function click(text) {
  const button = [...container.querySelectorAll('button')].find(el => el.textContent.includes(text));
  assert.ok(button, `button ${text} exists`);
  button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
}

test('per-user key card shows status and disclosure, saves replacement and removes without echoing key', async () => {
  calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ configured: url === '/api/jev' && options.method !== 'DELETE' }) };
  };
  await act(async () => root.render(React.createElement(JevSettingsCard)));
  assert.match(container.textContent, /admin\.integrations\.jev\.configured/);
  assert.match(container.textContent, /admin\.integrations\.jev\.disclosure/);
  const input = container.querySelector('input[type=password]');
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(input, 'new-secret');
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  await act(async () => click('admin.integrations.jev.save'));
  assert.ok(calls.some(c => c.options.method === 'PUT' && JSON.parse(c.options.body).apiKey === 'new-secret'));
  assert.doesNotMatch(container.textContent, /new-secret/);
  await act(async () => click('admin.integrations.jev.remove'));
  assert.ok(calls.some(c => c.options.method === 'DELETE'));
});

test('rule tester selects recent messages, shows probabilities and never sends actions', async () => {
  calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    const data = url.includes('jev-samples')
      ? { messages: [{ id: 'm1', subject: 'Question', fromEmail: 'a@example.org', accountId: 'a1' }] }
      : { results: [{ id: 'm1', subject: 'Question', probability: 0.91, match: true, available: true }] };
    return { ok: true, json: async () => data };
  };
  await act(async () => root.render(React.createElement(JevRuleTester, { condition: { field: 'jev', question: 'Needs reply?', threshold: 0.8 }, accountId: 'a1' })));
  await act(async () => click('admin.rules.jev.loadSamples'));
  const checkbox = container.querySelector('input[type=checkbox]');
  assert.ok(checkbox);
  await act(async () => checkbox.click());
  await act(async () => click('admin.rules.jev.test'));
  assert.match(container.textContent, /0\.91/);
  const request = calls.find(c => c.url.endsWith('/rules/test-jev'));
  assert.deepEqual(JSON.parse(request.options.body), { condition: { field: 'jev', question: 'Needs reply?', threshold: 0.8 }, messageIds: ['m1'] });
  assert.ok(calls.every(c => !c.url.endsWith('/rules/run')));
  await act(async () => root.render(React.createElement(JevRuleTester,
    { condition: { field: 'jev', question: 'Invoice?', threshold: 0.9 }, accountId: 'a1' })));
  assert.doesNotMatch(container.textContent, /0\.91/);
});
