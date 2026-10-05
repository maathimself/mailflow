// Render test for the Backup tab (#452): the switch stores the default scope, the download is
// checked and then a navigation carrying that scope, and a restore confirms, streams progress,
// then waits for the server to go away and come back before reloading.
//
// Same loader hooks as ProfileModal.render.test.js: node --test cannot parse JSX, and
// react-i18next is stubbed (here with the interpolation values appended, so messages can be
// checked).

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) {
      return { format: 'module', shortCircuit: true, source: [
        'export const useTranslation = () => ({ t: (k, o) => (o ? k + " " + JSON.stringify(o) : k), i18n: { language: "en", changeLanguage: () => {} } });',
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
    const path = url.split('?')[0];
    if (path.endsWith('.jsx')) {
      const out = transform(readFileSync(new URL(path), 'utf8'), { transforms: ['jsx'], jsxRuntime: 'automatic', filePath: path });
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
globalThis.requestAnimationFrame ??= cb => setTimeout(() => cb(Date.now()), 0);
globalThis.cancelAnimationFrame ??= id => clearTimeout(id);
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };

// The fake API. Each test sets the answers it needs; health answers are consumed in order and
// the last one repeats.
const CALLS = [];
let settings;
let settingsGate;
let patchResponse;
let checkResponse;
let restoreResponse;
let health;
globalThis.fetch = async (url, init = {}) => {
  const path = String(url);
  const method = init.method || 'GET';
  CALLS.push({ path, method, init });
  if (path.endsWith('/api/admin/settings') && method === 'GET') {
    await settingsGate;
    return new Response(JSON.stringify({ settings }), { status: 200 });
  }
  if (path.endsWith('/api/admin/settings') && method === 'PATCH') return patchResponse();
  if (path.includes('/api/admin/backup/check')) return checkResponse();
  if (path.endsWith('/api/admin/backup/restore')) return restoreResponse(init);
  if (path.includes('/api/health')) return new Response('{}', { status: (health.length > 1 ? health.shift() : health[0]) ? 200 : 503 });
  throw new Error('unexpected fetch ' + method + ' ' + path);
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const stream = (lines, { hold } = {}) => new Response(new ReadableStream({
  async start(controller) {
    for (const line of lines) {
      if (line === hold?.at) await hold.promise;
      controller.enqueue(new TextEncoder().encode(JSON.stringify(line) + '\n'));
    }
    controller.close();
  },
}), { status: 200 });

const { default: React } = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const { useStore } = await import('../store/index.js');

const host = document.getElementById('root');
let root;
let reloads;
let clock;
// The restore's progress lives at module level, so each test gets its own copy of the module.
let BackupSettings;
let copies = 0;
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
const until = async (check, what) => {
  for (let i = 0; i < 60; i++) { if (check()) return; await flush(); }
  assert.fail(`timed out waiting for ${what}; page shows: ${host.textContent}`);
};
const buttonByText = text => [...host.querySelectorAll('button')].find(b => b.textContent === text);
const toggle = () => host.querySelector('button[aria-pressed]');
const click = el => act(async () => { el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
const healthProbes = () => CALLS.filter(c => c.path.includes('/api/health')).length;
const notifications = () => useStore.getState().notifications;
async function mount() {
  root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(BackupSettings, {
      reload: () => reloads.push(healthProbes()),
      sleep: ms => { clock += ms; return Promise.resolve(); },
      now: () => clock,
    }));
  });
  await flush();
}
async function chooseFile() {
  const input = host.querySelector('input[type="file"]');
  const file = new File(['gz'], 'mailflow-backup-2026-09-29T10-00-00-setup.json.gz', { type: 'application/gzip' });
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => { input.dispatchEvent(new dom.window.Event('change', { bubbles: true })); });
  return file;
}
async function confirmRestore() {
  await click(buttonByText('admin.backup.restore'));
  await click(buttonByText('admin.backup.confirmYes'));
}
function captureNavigations() {
  const hrefs = [];
  const original = dom.window.HTMLAnchorElement.prototype.click;
  dom.window.HTMLAnchorElement.prototype.click = function () { hrefs.push(this.getAttribute('href')); };
  return { hrefs, restore: () => { dom.window.HTMLAnchorElement.prototype.click = original; } };
}

beforeEach(async () => {
  if (root) await act(async () => { root.unmount(); });
  CALLS.length = 0;
  reloads = [];
  clock = 0;
  useStore.setState({ notifications: [] });
  settings = { backup_include_mail: 'true' };
  settingsGate = Promise.resolve();
  patchResponse = () => json({ ok: true });
  checkResponse = () => json({ ok: true });
  restoreResponse = () => json({ error: 'unset' }, 500);
  health = [true];
  ({ default: BackupSettings } = await import(`./BackupSettings.jsx?copy=${++copies}`));
});

describe('BackupSettings', () => {
  test('the switch waits for the stored default, shows it, stores a change, and the download carries the scope', async () => {
    let open;
    settingsGate = new Promise(r => { open = r; });
    await mount();
    assert.equal(toggle().disabled, true, 'nothing to act on before the stored default is known');
    assert.equal(buttonByText('admin.backup.create').disabled, true);
    assert.equal(toggle().getAttribute('aria-label'), 'admin.backup.includeMail');
    open();
    await until(() => !toggle().disabled, 'the settings to load');
    assert.equal(toggle().getAttribute('aria-pressed'), 'true');

    const nav = captureNavigations();
    try {
      await click(buttonByText('admin.backup.create'));
      await until(() => nav.hrefs.length === 1, 'the download');
      assert.deepEqual(nav.hrefs, ['/api/admin/backup?scope=full']);
      assert.ok(CALLS.some(c => c.path.endsWith('/api/admin/backup/check?scope=full')), 'the backup is checked before the navigation');

      await click(toggle());
      assert.equal(toggle().getAttribute('aria-pressed'), 'false');
      assert.deepEqual(JSON.parse(CALLS.find(c => c.method === 'PATCH').init.body), { backup_include_mail: false });

      await click(buttonByText('admin.backup.create'));
      await until(() => nav.hrefs.length === 2, 'the second download');
      assert.equal(nav.hrefs[1], '/api/admin/backup?scope=setup');
    } finally {
      nav.restore();
    }
  });

  test('a switch change the server refused goes back, with a message', async () => {
    await mount();
    patchResponse = () => json({ error: 'nope' }, 500);
    await click(toggle());
    await until(() => toggle().getAttribute('aria-pressed') === 'true', 'the switch to go back');
    assert.equal(notifications()[0]?.title, 'admin.backup.includeMailSaveError');
  });

  test('a backup that cannot start says why on the page instead of downloading', async () => {
    await mount();
    checkResponse = () => json({ error: 'Tables not classified for backup: brand_new_table' }, 500);
    const nav = captureNavigations();
    try {
      await click(buttonByText('admin.backup.create'));
      await until(() => notifications().length === 1, 'the message');
      assert.deepEqual(nav.hrefs, []);
      assert.equal(notifications()[0].title, 'admin.backup.downloadFailed');
      assert.equal(notifications()[0].body, 'Tables not classified for backup: brand_new_table');
    } finally {
      nav.restore();
    }
  });

  test('a restore needs a file and a confirmation, streams progress, and reloads only once the server went away and came back', async () => {
    await mount();
    assert.equal(buttonByText('admin.backup.restore').disabled, true);
    const file = await chooseFile();
    assert.equal(buttonByText('admin.backup.restore').disabled, false);

    let release;
    const result = { ok: true, scope: 'setup', tables: 25, rows: 1300 };
    restoreResponse = () => stream([{ table: 'contacts', rows: 1204 }, result], { hold: { at: result, promise: new Promise(r => { release = r; }) } });
    // The first probe still reaches the old process; then it is gone; then the new one answers.
    health = [true, false, true];

    await click(buttonByText('admin.backup.restore'));
    assert.equal(CALLS.some(c => c.method === 'POST'), false, 'no request before the confirmation');
    assert.ok(host.textContent.includes(`admin.backup.confirmWarn {"name":"${file.name}"}`));

    await click(buttonByText('admin.backup.confirmYes'));
    await until(() => host.textContent.includes('admin.backup.restoring {"rows":1204}'), 'the progress line');
    const upload = CALLS.find(c => c.method === 'POST');
    assert.equal(upload.init.headers['Content-Type'], 'application/gzip');
    assert.equal(upload.init.headers['X-Requested-With'], 'MailFlow');
    assert.equal(upload.init.body, file);

    release();
    await until(() => reloads.length === 1, 'the reload');
    assert.ok(host.textContent.includes('admin.backup.done'));
    assert.deepEqual(reloads, [3], 'reloaded after the third probe, not the first');
  });

  test('a refused file shows the reason and leaves the page usable', async () => {
    await mount();
    await chooseFile();
    restoreResponse = () => json({ error: 'This backup was made on a server with a different ENCRYPTION_KEY.' }, 400);
    await confirmRestore();
    await until(() => host.textContent.includes('admin.backup.failed'), 'the failure');
    assert.ok(host.textContent.includes('different ENCRYPTION_KEY'));
    assert.ok(notifications().some(n => n.title.includes('different ENCRYPTION_KEY')), 'also shown outside this tab');
    assert.equal(reloads.length, 0);
    assert.equal(buttonByText('admin.backup.restore').disabled, false);
  });

  test('a proxy that refuses the upload size is explained as such', async () => {
    await mount();
    await chooseFile();
    restoreResponse = () => new Response('<html>413</html>', { status: 413 });
    await confirmRestore();
    await until(() => host.textContent.includes('admin.backup.failed'), 'the failure');
    assert.ok(host.textContent.includes('admin.backup.tooLarge'));
  });

  test('a reply cut off before its result is not reported as a failure, and the page still follows a restart', async () => {
    await mount();
    await chooseFile();
    restoreResponse = () => stream([{ table: 'users', rows: 3 }]);
    health = [false, true];
    await confirmRestore();
    await until(() => reloads.length === 1, 'the reload');
    assert.ok(host.textContent.includes('admin.backup.connectionLost'), host.textContent);
    assert.ok(!host.textContent.includes('admin.backup.failed'));
  });

  test('says so when MailFlow does not come back', async () => {
    await mount();
    await chooseFile();
    restoreResponse = () => stream([{ ok: true, scope: 'setup', tables: 1, rows: 1 }]);
    health = [false];
    await confirmRestore();
    await until(() => host.textContent.includes('admin.backup.restartTimeout'), 'the timeout message');
    assert.equal(reloads.length, 0);
    assert.ok(clock >= 120_000, 'it waited the full two minutes');
  });

  test('reloads after a while even when the restart was too quick to see', async () => {
    await mount();
    await chooseFile();
    restoreResponse = () => stream([{ ok: true, scope: 'setup', tables: 1, rows: 1 }]);
    health = [true];
    await confirmRestore();
    await until(() => reloads.length === 1, 'the reload');
    assert.ok(clock > 15_000 && clock < 20_000, `reloaded after the quiet period, at ${clock} ms`);
  });

  test('a failure the server reports inside the stream is a failure, not a lost connection', async () => {
    await mount();
    await chooseFile();
    restoreResponse = () => stream([{ table: 'users', rows: 3 }, { error: 'lock timeout' }]);
    await confirmRestore();
    await until(() => host.textContent.includes('admin.backup.failed'), 'the failure');
    assert.ok(host.textContent.includes('lock timeout'));
    assert.ok(!host.textContent.includes('admin.backup.connectionLost'));
    assert.equal(healthProbes(), 0, 'no restart to wait for');
  });

  test('choosing another file after a failure clears the old message', async () => {
    await mount();
    await chooseFile();
    restoreResponse = () => json({ error: 'This is not a MailFlow backup file.' }, 400);
    await confirmRestore();
    await until(() => host.textContent.includes('admin.backup.failed'), 'the failure');
    await chooseFile();
    assert.ok(!host.textContent.includes('admin.backup.failed'), host.textContent);
  });

  test('coming back to the tab during a restore shows it still running', async () => {
    await mount();
    await chooseFile();
    let release;
    const result = { ok: true, scope: 'setup', tables: 1, rows: 1 };
    restoreResponse = () => stream([{ table: 'users', rows: 7 }, result], { hold: { at: result, promise: new Promise(r => { release = r; }) } });
    health = [false, true];
    await confirmRestore();
    await until(() => host.textContent.includes('admin.backup.restoring {"rows":7}'), 'the progress line');
    await act(async () => { root.unmount(); });
    await mount();
    assert.ok(host.textContent.includes('admin.backup.restoring {"rows":7}'), host.textContent);
    assert.equal(toggle().disabled, true);
    assert.equal(buttonByText('admin.backup.create').disabled, true);
    release();
    await until(() => reloads.length === 1, 'the reload');
  });

  test('a second click on Download while the first is being checked does nothing', async () => {
    await mount();
    let answer;
    checkResponse = () => new Promise(r => { answer = r; });
    const nav = captureNavigations();
    try {
      await click(buttonByText('admin.backup.create'));
      await click(buttonByText('admin.backup.create'));
      assert.equal(CALLS.filter(c => c.path.includes('/api/admin/backup/check')).length, 1);
      answer(json({ ok: true }));
      await until(() => nav.hrefs.length === 1, 'the download');
      assert.equal(buttonByText('admin.backup.create').disabled, false);
    } finally {
      nav.restore();
    }
  });
});
