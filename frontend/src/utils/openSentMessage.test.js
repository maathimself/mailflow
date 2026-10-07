// Run with: node --test src/utils/openSentMessage.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { create } from 'zustand';
import { openSentMessage } from './openSentMessage.js';

const SENT = { accountId: 'acct', folder: 'Sent', messageId: '<abc@example.test>' };

function makeStore() {
  return create(set => ({
    selectedAccountId: null, selectedFolder: 'INBOX', selectedMessageId: null, messages: [],
    setSelectedAccount: (selectedAccountId, selectedFolder) => set({ selectedAccountId, selectedFolder, selectedMessageId: null, messages: [] }),
    setSelectedMessage: selectedMessageId => set({ selectedMessageId }),
  }));
}
const timers = () => {
  const pending = new Set();
  return {
    pending,
    schedule: fn => { const t = { fn }; pending.add(t); return t; },
    unschedule: t => { pending.delete(t); },
    fire: () => [...pending].forEach(t => { pending.delete(t); t.fn(); }),
  };
};

test('opens the Sent folder and then the message, once its copy is listed', () => {
  const store = makeStore();
  const clock = timers();
  openSentMessage(store, SENT, clock);
  assert.equal(store.getState().selectedAccountId, 'acct');
  assert.equal(store.getState().selectedFolder, 'Sent');
  assert.equal(store.getState().selectedMessageId, null, 'not listed yet');
  store.setState({ messages: [{ id: 'm1', message_id: '<other@example.test>' }, { id: 'm2', message_id: '<abc@example.test>' }] });
  assert.equal(store.getState().selectedMessageId, 'm2');
  assert.equal(clock.pending.size, 0, 'and stops waiting');
});

test('stops waiting once the user moves elsewhere', () => {
  const store = makeStore();
  const clock = timers();
  openSentMessage(store, SENT, clock);
  store.getState().setSelectedAccount('acct', 'INBOX');
  store.setState({ messages: [{ id: 'm2', message_id: '<abc@example.test>' }] });
  assert.equal(store.getState().selectedMessageId, null, 'their navigation wins');
  assert.equal(clock.pending.size, 0);
});

test('gives up after a while when the copy never shows up', () => {
  const store = makeStore();
  const clock = timers();
  openSentMessage(store, SENT, clock);
  clock.fire();
  store.setState({ messages: [{ id: 'm2', message_id: '<abc@example.test>' }] });
  assert.equal(store.getState().selectedMessageId, null);
});

test('without a Message-ID it still opens the folder', () => {
  const store = makeStore();
  openSentMessage(store, { accountId: 'acct', folder: 'Sent' }, timers());
  assert.equal(store.getState().selectedFolder, 'Sent');
});
