import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
registerHooks({ load(url, context, nextLoad) {
  return url.endsWith('.json') ? { format: 'module', source: `export default ${readFileSync(new URL(url), 'utf8')}`, shortCircuit: true } : nextLoad(url, context);
} });
const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, CustomEvent: dom.window.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true });

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore, selectAccountFolders } = await import('./index.js');

test('selectAccountFolders returns the same reference for an account without folders', () => {
  const state = useStore.getState();
  const first = selectAccountFolders(state, 'missing');
  const second = selectAccountFolders(state, 'missing');
  assert.deepEqual(first, []);
  assert.equal(first, second);
  assert.ok(Object.isFrozen(first));
});

test('selectAccountFolders returns the stored folder list for a known account', () => {
  const folders = [{ path: 'INBOX' }];
  useStore.getState().setFolders('acc-known', folders);
  const state = useStore.getState();
  assert.deepEqual(selectAccountFolders(state, 'acc-known'), folders);
  assert.equal(selectAccountFolders(state, 'acc-known'), selectAccountFolders(state, 'acc-known'));
});

test('a component subscribed through selectAccountFolders renders without an update loop', async () => {
  let renders = 0;
  function FolderCount({ accountId }) {
    renders++;
    const folders = useStore(s => selectAccountFolders(s, accountId));
    return React.createElement('span', null, String(folders.length));
  }
  const container = document.getElementById('root');
  const root = createRoot(container);
  const consoleErrors = [];
  const originalError = console.error;
  console.error = (...args) => consoleErrors.push(args.map(String).join(' '));
  try {
    await React.act(async () => {
      root.render(React.createElement(FolderCount, { accountId: 'acc-without-folders' }));
    });
    assert.equal(container.textContent, '0');
    assert.ok(renders < 5, `expected a bounded number of renders, got ${renders}`);

    await React.act(async () => {
      useStore.getState().setFolders('acc-without-folders', [{ path: 'INBOX' }, { path: 'Sent' }]);
    });
    assert.equal(container.textContent, '2');
    assert.deepEqual(consoleErrors, []);
  } finally {
    console.error = originalError;
    await React.act(async () => root.unmount());
    dom.window.close();
  }
});
