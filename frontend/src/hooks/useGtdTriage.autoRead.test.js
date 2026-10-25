// GTD's delayed read-on-open (#683). Opening a rail row with "mark read after a delay" schedules
// a read of the thread. It was a bare setTimeout that only the rail itself could cancel, so a
// manual read or unread of the opened message from the reading pane, the list or a hotkey did not
// stop it: it re-read a message just marked unread, or sent a second read for one marked read.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) {
      return { format: 'module', shortCircuit: true, source: [
        'export const useTranslation = () => ({ t: k => k, i18n: { language: "en", changeLanguage: () => {} } });',
        'export const initReactI18next = { type: "3rdParty", init: () => {} };',
        'export default { useTranslation, initReactI18next };',
      ].join('\n') };
    }
    if (url.endsWith('.json')) {
      return { format: 'module', shortCircuit: true, source: `export default ${readFileSync(new URL(url), 'utf8')}` };
    }
    return nextLoad(url, context);
  },
});

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid', pretendToBeVisual: true });
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage,
  HTMLElement: dom.window.HTMLElement, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true,
});

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const { api } = await import('../utils/api.js');
const { cancelScheduledMarkReadFor } = await import('../utils/markRead.js');
const { useGtdTriage } = await import('./useGtdTriage.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));
let seq = 0;
let root, triage, reads, saved;

function Probe() {
  triage = useGtdTriage();
  return null;
}

beforeEach(async () => {
  saved = { getMessage: api.getMessage, bulkRead: api.bulkRead, state: useStore.getState() };
  reads = [];
  api.bulkRead = async (ids, read) => { reads.push(read); return {}; };
  useStore.setState({ markReadBehavior: 'delay', markReadDelay: 1, scheduleGtdSectionsFetch() {} });
  root = createRoot(document.getElementById('root'));
  await React.act(async () => root.render(React.createElement(Probe)));
});

afterEach(async () => {
  await React.act(async () => root.unmount());
  api.getMessage = saved.getMessage;
  api.bulkRead = saved.bulkRead;
  useStore.setState(saved.state);
});

// Open a rail row whose deep link resolves to a message with a different id (the inbox copy).
async function openFromRail() {
  const n = ++seq;
  const thread = { id: `rail-${n}`, message_id: `<gtd-${n}@example.invalid>`, account_id: 'a', is_read: false };
  const opened = { ...thread, id: `inbox-${n}` };
  api.getMessage = async () => opened;
  await React.act(async () => { await triage.openRow(thread); });
  return { thread, opened };
}

describe("GTD's delayed read-on-open (#683)", () => {
  test('a manual unread of the opened message cancels it', async () => {
    const { opened } = await openFromRail();
    assert.equal(useStore.getState().selectedMessageId, opened.id);
    // What the reading pane, the list and the u hotkey do for the message they act on.
    cancelScheduledMarkReadFor(opened.id);
    await sleep(1300);
    assert.deepEqual(reads, []);
  });

  test('a manual read from the rail itself cancels it, so it reads once', async () => {
    const { thread } = await openFromRail();
    await React.act(async () => { await triage.handleGtdAction('markRead', { message: thread }); });
    await sleep(1300);
    assert.deepEqual(reads, [true]);
  });

  test('left alone, it still reads the thread once', async () => {
    await openFromRail();
    await sleep(1300);
    assert.deepEqual(reads, [true]);
  });
});
