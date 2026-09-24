import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) {
    return { format: 'module', shortCircuit: true, source: [
      'export const useTranslation = () => ({ t: (k, o) => k === "commandPalette.labelPicker.copyTo" ? `Translated to ${o.folder}` : k === "commandPalette.labelPicker.placeholder" ? "Translated picker" : k === "commandPalette.labelPicker.error" ? "Translated error" : o?.defaultValue ?? k, i18n: { language: "en", changeLanguage() {} } });',
      'export const initReactI18next = { type: "3rdParty", init() {} };',
      'export const Trans = ({ children }) => children ?? null;',
      'export const I18nextProvider = ({ children }) => children ?? null;',
      'export default { useTranslation, initReactI18next };',
    ].join('\n') };
  }
  if (url.endsWith('.json')) {
    return { format: 'module', source: `export default ${readFileSync(new URL(url), 'utf8')}`, shortCircuit: true };
  }
  if (url.endsWith('.jsx')) {
    const code = readFileSync(new URL(url), 'utf8');
    return { format: 'module', source: transform(code, { transforms: ['jsx'], jsxRuntime: 'automatic', filePath: url }).code, shortCircuit: true };
  }
  return nextLoad(url, context);
} });

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid' });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
  CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
dom.window.Element.prototype.scrollIntoView = () => {};

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const { api } = await import('../utils/api.js');
const CommandPalette = (await import('./CommandPalette.jsx')).default;

test('repeated label choice activation copies only once while the request is pending', async () => {
  const originalCopy = api.copyMessage;
  const originalAddNotification = useStore.getState().addNotification;
  const root = createRoot(document.getElementById('root'));
  const calls = [];
  const notifications = [];
  let release;
  api.copyMessage = (...args) => {
    calls.push(args);
    return new Promise(resolve => { release = resolve; });
  };
  useStore.setState({
    accounts: [{ id: 'a', enabled: true }],
    folders: { a: [{ path: 'Projects', name: 'Projects' }] },
    addNotification: notification => notifications.push(notification),
  });
  let closes = 0;
  try {
    await React.act(async () => {
      root.render(React.createElement(CommandPalette, {
        open: true, onClose: () => { closes++; },
        labelPickerMessage: { id: 'm', account_id: 'a', folder: 'INBOX' },
      }));
    });
    assert.equal(document.querySelector('input').placeholder, 'Translated picker');
    const choice = [...document.querySelectorAll('div')]
      .find(el => el.style.cursor === 'pointer' && el.textContent.includes('Translated to Projects'));
    assert.ok(choice);
    await React.act(async () => { choice.click(); choice.click(); });
    assert.deepEqual(calls, [['m', 'Projects']]);
    assert.equal(closes, 0);
    await React.act(async () => { release({ copied: true }); });
    assert.equal(closes, 1);
    api.copyMessage = async () => { throw new Error('Copy failed'); };
    await React.act(async () => { choice.click(); });
    assert.deepEqual(notifications, [{ title: 'Translated error', body: 'Copy failed' }]);
  } finally {
    await React.act(async () => root.unmount());
    api.copyMessage = originalCopy;
    useStore.setState({ addNotification: originalAddNotification });
    dom.window.close();
  }
});
