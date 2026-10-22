// The Snoozed view's actions (#269): what the reader sees at once, and what happens when the
// server refuses.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('.json')) return { format: 'module', shortCircuit: true, source: `export default ${readFileSync(new URL(url), 'utf8')}` };
    return nextLoad(url, context);
  },
});
const dom = new JSDOM('<div></div>', { url: 'https://mail.example.invalid' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, CustomEvent: dom.window.CustomEvent });
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

const { useStore } = await import('../store/index.js');
const { api } = await import('./api.js');
const { unsnooze, changeSnooze, isSnoozed } = await import('./snoozeActions.js');

const t = (k, o) => (o?.when ? `${k}:${o.when}` : k);
const MSG = { id: 'm1', account_id: 'a', folder: 'Snoozed', subject: 'Invoice', is_read: true, snooze_until: '2030-01-01T09:00:00.000Z' };
const settle = () => new Promise(r => setTimeout(r, 0));
const toasts = () => useStore.getState().notifications.map(n => n.title);

describe('snooze actions', () => {
  beforeEach(() => { useStore.setState({ messages: [{ ...MSG }], notifications: [] }); });

  test('isSnoozed: mail waiting in the Snoozed folder', () => {
    assert.equal(isSnoozed(MSG), true);
    assert.equal(isSnoozed({ ...MSG, folder: 'INBOX' }), false);
  });

  // A server with an INBOX. namespace prefix keeps it in INBOX.Snoozed, which the Snoozed view
  // gives as the folder the row's snooze was filed into.
  test('isSnoozed: mail waiting in the folder its snooze was filed into', () => {
    const prefixed = { ...MSG, folder: 'INBOX.Snoozed', snoozed_folder: 'INBOX.Snoozed' };
    assert.equal(isSnoozed(prefixed), true);
    assert.equal(isSnoozed({ ...prefixed, folder: 'INBOX' }), false);
    assert.equal(isSnoozed({ ...prefixed, snoozed_folder: undefined }), false);
    assert.equal(isSnoozed({ id: 'x' }), false);
    assert.equal(isSnoozed(undefined), false);
  });

  test('unsnooze takes it out of the view at once', async () => {
    api.unsnoozeMessage = async () => ({ ok: true });
    await unsnooze(MSG, { t });
    assert.deepEqual(useStore.getState().messages, []);
    assert.deepEqual(toasts(), ['message.unsnoozed.title']);
  });

  test('a refused unsnooze puts it back, and says so', async () => {
    api.unsnoozeMessage = async () => { throw new Error('nope'); };
    const logged = console.error; console.error = () => {};
    try { await unsnooze(MSG, { t }); await settle(); } finally { console.error = logged; }
    assert.deepEqual(useStore.getState().messages.map(m => m.id), ['m1']);
    assert.ok(toasts().includes('message.unsnoozed.failTitle'));
  });

  test('changing the time shows the new one at once, and the old one again if refused', async () => {
    const until = '2030-02-02T10:00:00.000Z';
    api.changeSnooze = async () => ({ ok: true });
    await changeSnooze(MSG, until, { t });
    assert.equal(useStore.getState().messages[0].snooze_until, until);

    useStore.setState({ messages: [{ ...MSG }], notifications: [] });
    api.changeSnooze = async () => { throw new Error('nope'); };
    const logged = console.error; console.error = () => {};
    try { await changeSnooze(MSG, until, { t }); await settle(); } finally { console.error = logged; }
    assert.equal(useStore.getState().messages[0].snooze_until, MSG.snooze_until);
    assert.ok(toasts().includes('message.snoozeChanged.failTitle'));
  });
});
