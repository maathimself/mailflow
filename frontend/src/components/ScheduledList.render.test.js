// Render test for the Scheduled view (#543, design 5.2, 5.4 and 7.3): its sections, chips and
// reasons, the row actions and the requests they make, the questions they ask first, the
// refusals, Edit opening the composer in edit mode, the keyboard, the phone's action sheet, the
// empty state, and a notification link's highlight.
//
// Mounted the way ComposeModal.sendLater.render.test.js mounts the composer.

import { test, describe, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) {
      return { format: 'module', shortCircuit: true, source: [
        'const t = (k, o) => (o && typeof o === "object" && Object.keys(o).length ? `${k}:${JSON.stringify(o)}` : k);',
        'export const useTranslation = () => ({ t, i18n: { language: "en", changeLanguage: () => {} } });',
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
  window: dom.window, document: dom.window.document,
  localStorage: dom.window.localStorage, CustomEvent: dom.window.CustomEvent,
  Node: dom.window.Node, Element: dom.window.Element, HTMLElement: dom.window.HTMLElement,
  getComputedStyle: dom.window.getComputedStyle, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IS_REACT_ACT_ENVIRONMENT: true,
});
dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
dom.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
dom.window.Element.prototype.scrollIntoView = () => {};
globalThis.__VITE_ENV__ = { MODE: 'test', DEV: false, PROD: true };
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { useStore } = await import('../store/index.js');
const { api } = await import('../utils/api.js');
const { SCHEDULED_VIEW } = await import('../utils/scheduledCompose.js');
const { scheduledFeed } = await import('../utils/scheduledFeed.js');
const ScheduledList = (await import('./ScheduledList.jsx')).default;
const MessageList = (await import('./MessageList.jsx')).default;

const ACCOUNT = { id: 'acct', enabled: true, email_address: 'me@example.invalid', name: 'Work', color: '#36c' };
const ID = { scheduled: '10000000-0000-4000-8000-000000000001', failed: '10000000-0000-4000-8000-000000000002', paused: '10000000-0000-4000-8000-000000000003',
  uncertain: '10000000-0000-4000-8000-000000000004', sent: '10000000-0000-4000-8000-000000000005', editing: '10000000-0000-4000-8000-000000000006',
  restored: '10000000-0000-4000-8000-000000000007' };
const future = (days) => new Date(Date.now() + days * 86_400_000).toISOString();
const summary = (subject, extra = {}) => ({ subject, to: ['Alice <alice@example.invalid>', 'bob@example.invalid', 'carol@example.invalid'], ccCount: 1, bccCount: 0, snippet: 'Body text', attachmentCount: 2, ...extra });
const base = { accountId: 'acct', version: 3, attempts: 0, sentAt: null, sentLate: false, pauseReason: null, failureCode: null, failureDetail: null, result: null, timeZone: null };
const LIST = {
  moreSent: true,
  messages: [
    { ...base, id: ID.scheduled, status: 'scheduled', sendAt: future(3), dueAt: future(3), timeZone: 'Pacific/Kiritimati', summary: summary('Q4 numbers') },
    { ...base, id: ID.editing, status: 'editing', sendAt: future(4), dueAt: future(4), summary: summary('Being edited') },
    { ...base, id: ID.failed, status: 'failed', sendAt: future(-1), failureCode: 'smtp_rejected', failureDetail: '550 5.1.1 no such user', summary: summary('Refused one') },
    { ...base, id: ID.paused, status: 'paused', sendAt: future(-2), pauseReason: 'needs_reauth', failureCode: 'auth_failed', summary: summary('Needs sign in') },
    { ...base, id: ID.restored, status: 'paused', sendAt: future(-2.5), pauseReason: 'restored', summary: summary('From a backup') },
    { ...base, id: ID.uncertain, status: 'uncertain', sendAt: future(-3), failureCode: 'connection_lost', summary: summary('Maybe sent') },
    {
      ...base, id: ID.sent, status: 'sent', sendAt: future(-1), sentAt: future(-0.9), sentLate: true, summary: null,
      result: { sentFolder: 'Sent', messageId: '<m1@example.invalid>', sentCopySaved: true, rejected: ['x@example.invalid'], deferred: [], lateReason: 'offline' },
    },
  ],
};
const DETAIL = {
  ...LIST.messages[0], spec: {
    to: ['Alice <alice@example.invalid>'], cc: [], bcc: [], subject: 'Q4 numbers', body: '<p>Here</p>', signature: null,
    compose: { isReply: true, threadId: 't1' },
  },
  attachments: [{ index: 0, filename: 'q4.pdf', size: 100, contentType: 'application/pdf', kind: 'upload' }],
};
const refusal = (status, code, message = 'server words', extra = {}) => Object.assign(new Error(message), { status, ...(code ? { code } : {}), ...extra });

const calls = [];
let answers = {};
function answer(name, args) {
  calls.push([name, ...args]);
  const next = answers[name];
  const value = Array.isArray(next) ? next.shift() : next;
  const result = typeof value === 'function' ? value(...args) : value;
  return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
}
const callsTo = (name) => calls.filter(c => c[0] === name);

before(() => {
  for (const name of ['list', 'get', 'reschedule', 'sendNow', 'undoSendNow', 'resume', 'sendAnyway', 'markSent', 'cancel', 'restore', 'remove']) {
    api.scheduled[name] = (...a) => answer(name, a);
  }
  api.getUnreadCounts = async () => ({ total: 0, byAccount: {}, snapshots: {}, scheduled: { pending: 2, attention: 4 } });
});
beforeEach(() => {
  calls.length = 0;
  answers = {
    list: () => structuredClone(LIST),
    get: () => structuredClone(DETAIL),
    reschedule: (id, { sendAt }) => ({ status: 'scheduled', sendAt }),
    sendNow: () => ({ status: 'scheduled', sendAt: future(0), undoToken: 'undo-1', undoUntil: future(0) }),
    undoSendNow: { status: 'scheduled', sendAt: future(3) },
    resume: { status: 'scheduled', sendAt: future(0) },
    sendAnyway: { status: 'scheduled', sendAt: future(0) },
    markSent: { status: 'sent' },
    cancel: { status: 'cancelled', undoUntil: future(0.01) },
    restore: { status: 'scheduled', sendAt: future(3) },
    remove: null,
  };
});

const settle = () => React.act(async () => { await new Promise(r => setTimeout(r, 5)); });
const click = (el) => React.act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
const key = (el, k, extra = {}) => React.act(async () => {
  el.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra }));
});
const rowEl = (id) => document.querySelector(`[data-scheduled-row="${id}"]`);
const mainButton = (id) => rowEl(id).querySelector('button');
const hover = (id) => React.act(async () => { rowEl(id).dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true })); });
const action = (id, name) => rowEl(id).querySelector(`[data-scheduled-action="${name}"]`);
const question = () => document.querySelector('[role="alertdialog"]');
const questionButton = (label) => [...question().querySelectorAll('button')].find(b => b.textContent === label);
const notifications = () => useStore.getState().notifications;

let root = null;
async function mount({ mobile = false, component = ScheduledList, state = {} } = {}) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: mobile ? 375 : 1280 });
  useStore.setState({
    user: { id: 'u1' }, isLocked: false, accounts: [ACCOUNT], notifications: [], composing: false, composeData: null,
    prepareComposeSwitch: null, scheduledList: null, scheduledSummaries: {}, scheduledHighlight: null,
    selectedAccountId: null, selectedFolder: SCHEDULED_VIEW, layout: 'comfortable', ...state,
  });
  root = createRoot(document.getElementById('root'));
  await React.act(async () => { root.render(React.createElement(component)); });
  await settle();
  await settle();
}
afterEach(async () => {
  // Let the list fetched again after an action land inside act.
  await settle();
  await settle();
  if (root) await React.act(async () => root.unmount());
  root = null;
});

describe('sections and rows', () => {
  test('needs attention first, then scheduled, then sent, with their counts and the older-sent note', async () => {
    await mount();
    const sections = [...document.querySelectorAll('[data-scheduled-section]')];
    assert.deepEqual(sections.map(s => s.dataset.scheduledSection), ['attention', 'upcoming', 'sent']);
    assert.deepEqual([...sections[0].querySelectorAll('[data-scheduled-row]')].map(r => r.dataset.scheduledRow), [ID.uncertain, ID.restored, ID.paused, ID.failed]);
    assert.deepEqual([...sections[1].querySelectorAll('[data-scheduled-row]')].map(r => r.dataset.scheduledRow), [ID.scheduled, ID.editing]);
    assert.ok(sections[0].querySelector('h3').textContent.includes('scheduled.sections.attention'));
    assert.ok(sections[0].querySelector('h3').textContent.includes('4'));
    assert.ok(sections[2].textContent.includes('scheduled.moreSent'));
  });

  test('a row shows recipients, subject, attachments, account, time, and the stored zone when it differs', async () => {
    await mount();
    const text = rowEl(ID.scheduled).textContent;
    assert.ok(text.includes('scheduled.toMore:{"names":"Alice, bob@example.invalid","more":2}'));
    assert.ok(text.includes('Q4 numbers'));
    assert.ok(text.includes(' - Body text'));
    assert.ok(text.includes('Work'), 'the account');
    assert.ok(/scheduled\.zoneTime:\{"time":".+","zone":"Pacific\/Kiritimati"\}/.test(text), 'the zone it was scheduled in');
    assert.equal(rowEl(ID.scheduled).querySelector('[data-scheduled-chip]'), null, 'a plain scheduled message has no chip');
  });

  test('chips and reasons in words, with the server detail', async () => {
    await mount();
    const chip = id => rowEl(id).querySelector('[data-scheduled-chip]').textContent;
    assert.equal(chip(ID.failed), 'scheduled.chip.failed');
    assert.equal(chip(ID.paused), 'scheduled.chip.paused');
    assert.equal(chip(ID.uncertain), 'scheduled.chip.uncertain');
    assert.equal(chip(ID.editing), 'scheduled.chip.editing');
    assert.equal(chip(ID.sent), 'scheduled.chip.sentLate');
    assert.ok(rowEl(ID.failed).textContent.includes('scheduled.reason.smtpRejected'));
    assert.ok(rowEl(ID.failed).textContent.includes('scheduled.serverReply:{"detail":"550 5.1.1 no such user"}'));
    assert.ok(rowEl(ID.paused).textContent.includes('scheduled.reason.needsReauth'));
    assert.ok(rowEl(ID.restored).textContent.includes('scheduled.reason.restored'));
    assert.ok(rowEl(ID.uncertain).textContent.includes('scheduled.reason.uncertain'));
  });

  test('a sent row: its notes, and the content the server deleted said as such', async () => {
    await mount();
    const sent = rowEl(ID.sent);
    assert.ok(sent.textContent.includes('scheduled.sentMessage'));
    assert.ok(sent.querySelector('[data-scheduled-note="late"]').textContent.startsWith('scheduled.sent.lateOffline'));
    assert.ok(sent.querySelector('[data-scheduled-note="rejected"]').textContent.includes('x@example.invalid'));
  });

  test('each row has an accessible name with time, recipients, subject and state', async () => {
    await mount();
    const label = mainButton(ID.failed).getAttribute('aria-label');
    assert.match(label, /^scheduled\.a11y\.scheduledFor:/);
    assert.match(label, /scheduled\.a11y\.toMore/);
    assert.match(label, /scheduled\.a11y\.subject:\{"subject":"Refused one"\}/);
    assert.match(label, /scheduled\.chip\.failed: scheduled\.reason\.smtpRejected$/);
  });

  test('the empty state', async () => {
    answers.list = { messages: [], moreSent: false };
    await mount();
    assert.ok(document.body.textContent.includes('scheduled.empty'));
    assert.ok(document.body.textContent.includes('scheduled.emptyDesc'));
  });

  test('MessageList shows the view for its id with no account selected', async () => {
    await mount({ component: MessageList });
    assert.ok(document.querySelector('[data-scheduled-view]'));
    assert.ok(rowEl(ID.scheduled));
  });
});

describe('actions', () => {
  test('a click edits: the composer opens in edit mode with the decrypted spec', async () => {
    await mount();
    await click(mainButton(ID.scheduled));
    await settle();
    assert.deepEqual(callsTo('get'), [['get', ID.scheduled]]);
    const { composing, composeData } = useStore.getState();
    assert.equal(composing, true);
    assert.equal(composeData.subject, 'Q4 numbers');
    assert.equal(composeData.isReply, true);
    assert.equal(composeData.threadId, 't1');
    assert.equal(composeData.restored, undefined);
    assert.deepEqual(composeData.scheduled, {
      id: ID.scheduled, version: 3, sendAt: LIST.messages[0].sendAt, timeZone: 'Pacific/Kiritimati',
      attachments: [{ index: 0, filename: 'q4.pdf', size: 100, contentType: 'application/pdf', kind: 'upload' }],
    });
  });

  test('Edit of a message that went out meanwhile says so instead', async () => {
    answers.get = () => ({ ...structuredClone(DETAIL), status: 'sending', spec: null });
    await mount();
    await click(mainButton(ID.scheduled));
    await settle();
    assert.equal(useStore.getState().composing, false);
    assert.equal(notifications()[0].body, 'scheduled.errors.sending');
  });

  test('Reschedule offers the Send later times and sends the one chosen with this zone', async () => {
    await mount();
    await hover(ID.scheduled);
    await click(action(ID.scheduled, 'reschedule'));
    const menu = rowEl(ID.scheduled).querySelector('[role="menu"]');
    assert.ok(menu.getAttribute('aria-label').includes('scheduled.actions.reschedule'));
    await click(menu.querySelector('[data-preset="tomorrowMorning"]'));
    await settle();
    const [[, id, body, confirm]] = callsTo('reschedule');
    assert.equal(id, ID.scheduled);
    assert.equal(new Date(body.sendAt).getHours(), 8);
    assert.equal(typeof body.timeZone, 'string');
    assert.equal(confirm, false);
    assert.match(notifications()[0].title, /^compose\.scheduleSend\.scheduledFor/);
    assert.ok(callsTo('list').length >= 2, 'the list is fetched again');
  });

  test('Reschedule of an uncertain message asks first, then repeats with confirm', async () => {
    answers.reschedule = [refusal(409, 'confirm_uncertain'), { status: 'scheduled', sendAt: future(1) }];
    await mount();
    await hover(ID.uncertain);
    await click(action(ID.uncertain, 'reschedule'));
    await click(rowEl(ID.uncertain).querySelector('[data-preset="tomorrowMorning"]'));
    await settle();
    assert.ok(question().textContent.includes('scheduled.confirm.uncertainTitle'));
    await click(questionButton('compose.scheduleSend.confirm.go'));
    await settle();
    assert.deepEqual(callsTo('reschedule').map(c => c[3]), [false, true]);
  });

  test('Send now offers the 10 s Undo, which puts it back', async () => {
    await mount();
    await hover(ID.scheduled);
    await click(action(ID.scheduled, 'sendNow'));
    await settle();
    assert.deepEqual(callsTo('sendNow'), [['sendNow', ID.scheduled, false]]);
    const [toast] = notifications();
    assert.match(toast.title, /^compose\.undoSend\.sending/);
    assert.ok(toast.undoMs > 9000 && toast.undoMs <= 10_000);
    await React.act(async () => { await toast.onUndo(); });
    assert.deepEqual(callsTo('undoSendNow'), [['undoSendNow', ID.scheduled, 'undo-1']]);
  });

  test('Send now again in its window does nothing, so the first Undo still puts it back', async () => {
    await mount();
    await hover(ID.scheduled);
    await click(action(ID.scheduled, 'sendNow'));
    await settle();
    // The list fetched after it does not say so yet (the mock answers the same list).
    await hover(ID.scheduled);
    await click(action(ID.scheduled, 'sendNow'));
    mainButton(ID.scheduled).focus();
    await key(mainButton(ID.scheduled), 's');
    await settle();
    assert.equal(callsTo('sendNow').length, 1);
    assert.equal(notifications().filter(n => n.onUndo).length, 1, 'the first Undo is still offered');
  });

  test('a message the list says is being sent now offers no Send now, and a refusal says why', async () => {
    answers.list = () => {
      const list = structuredClone(LIST);
      list.messages.find(m => m.id === ID.scheduled).sendingNow = true;
      return list;
    };
    await mount();
    await hover(ID.scheduled);
    assert.equal(action(ID.scheduled, 'sendNow'), null);
    mainButton(ID.scheduled).focus();
    await key(mainButton(ID.scheduled), 's');
    await settle();
    assert.equal(callsTo('sendNow').length, 0);

    answers.list = () => structuredClone(LIST);
    answers.sendNow = refusal(409, 'sending_now', 'This message is about to be sent.', { state: 'scheduled' });
    await React.act(async () => { await scheduledFeed.refresh(); });
    await hover(ID.scheduled);
    await click(action(ID.scheduled, 'sendNow'));
    await settle();
    assert.equal(notifications()[0].body, 'scheduled.errors.aboutToSend');
  });

  test('Resume of a message waiting for a sign-in says what to do first', async () => {
    answers.resume = refusal(409, 'needs_reauth', 'Sign in to the account again first.');
    await mount();
    await hover(ID.paused);
    await click(action(ID.paused, 'resume'));
    await settle();
    const [toast] = notifications();
    assert.equal(toast.type, 'error');
    assert.equal(toast.body, 'scheduled.errors.needsReauth');
  });

  test('Resume of a message a restore paused asks first, and goes on with confirm', async () => {
    answers.resume = [refusal(409, 'confirm_restored'), { status: 'scheduled' }];
    await mount();
    await hover(ID.restored);
    await click(action(ID.restored, 'resume'));
    await settle();
    assert.ok(question().textContent.includes('scheduled.confirm.restoredBody'));
    await click(questionButton('scheduled.confirm.restoredGo'));
    await settle();
    assert.deepEqual(callsTo('resume'), [['resume', ID.restored, false], ['resume', ID.restored, true]]);
    assert.equal(notifications()[0].title, 'scheduled.toast.resumed');
  });

  test('Send anyway warns strongly before anything goes, and Cancel sends nothing', async () => {
    await mount();
    await hover(ID.uncertain);
    await click(action(ID.uncertain, 'sendAnyway'));
    assert.ok(question().textContent.includes('scheduled.confirm.sendAnywayBody'));
    assert.equal(document.activeElement, questionButton('common.cancel'), 'Cancel has the focus, not Send anyway');
    assert.equal(callsTo('sendAnyway').length, 0);
    await click(questionButton('common.cancel'));
    assert.equal(question(), null);
    assert.equal(callsTo('sendAnyway').length, 0);
    await click(action(ID.uncertain, 'sendAnyway'));
    await click(questionButton('scheduled.actions.sendAnyway'));
    await settle();
    assert.deepEqual(callsTo('sendAnyway'), [['sendAnyway', ID.uncertain]]);
  });

  test('Mark as sent asks, then marks it', async () => {
    await mount();
    await React.act(async () => {
      rowEl(ID.uncertain).dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 50 }));
    });
    const menu = document.querySelector('[role="menu"]');
    assert.deepEqual([...menu.querySelectorAll('[role="menuitem"]')].map(b => b.dataset.scheduledAction),
      ['sendAnyway', 'markSent', 'edit', 'reschedule', 'cancel', 'delete']);
    await click(menu.querySelector('[data-scheduled-action="markSent"]'));
    await click(questionButton('scheduled.actions.markSent'));
    await settle();
    assert.deepEqual(callsTo('markSent'), [['markSent', ID.uncertain]]);
  });

  test('Delete (the Delete key) cancels with Undo, and Undo restores it', async () => {
    answers.restore = { status: 'paused', sendAt: future(-0.01), pauseReason: 'user' };
    await mount();
    await key(mainButton(ID.scheduled), 'Delete');
    await settle();
    assert.deepEqual(callsTo('cancel'), [['cancel', ID.scheduled]]);
    const [toast] = notifications();
    assert.equal(toast.title, 'scheduled.toast.deleted');
    assert.equal(toast.undoMs, 10_000);
    await React.act(async () => { await toast.onUndo(); });
    assert.deepEqual(callsTo('restore'), [['restore', ID.scheduled]]);
    assert.equal(notifications()[0].title, 'scheduled.toast.restoredPaused', 'its time passed: it came back paused');
  });

  test('an Undo too late says it can no longer be restored', async () => {
    answers.restore = refusal(409, null, 'This can no longer be undone.', { state: 'cancelled' });
    await mount();
    await key(mainButton(ID.scheduled), 'Delete');
    await settle();
    await React.act(async () => { await notifications()[0].onUndo(); });
    assert.equal(notifications()[0].body, 'scheduled.errors.restoreExpired');
  });

  test('Delete for good asks, then deletes', async () => {
    await mount();
    await React.act(async () => {
      rowEl(ID.failed).dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 50 }));
    });
    await click(document.querySelector('[role="menu"] [data-scheduled-action="delete"]'));
    assert.ok(question().textContent.includes('scheduled.confirm.deleteBody'));
    assert.equal(document.activeElement, questionButton('common.cancel'), 'Cancel has the focus, not Delete');
    await click(questionButton('scheduled.actions.delete'));
    await settle();
    assert.deepEqual(callsTo('remove'), [['remove', ID.failed]]);
  });

  test('a refusal because it is being sent is said in words', async () => {
    answers.cancel = refusal(409, null, 'This message is being sent now.', { state: 'sending' });
    await mount();
    await key(mainButton(ID.scheduled), 'Delete');
    await settle();
    assert.equal(notifications()[0].body, 'scheduled.errors.sending');
  });
});

describe('keyboard', () => {
  test('arrows move between rows, with one tab stop; r reschedules and s sends now', async () => {
    await mount();
    const tabStops = [...document.querySelectorAll('[data-scheduled-row] > button[tabindex="0"]')];
    assert.equal(tabStops.length, 1);
    mainButton(ID.uncertain).focus();
    await key(mainButton(ID.uncertain), 'ArrowDown');
    assert.equal(document.activeElement, mainButton(ID.restored));
    await key(document.activeElement, 'End');
    assert.equal(document.activeElement, mainButton(ID.sent));
    await key(mainButton(ID.scheduled), 'r');
    assert.ok(rowEl(ID.scheduled).querySelector('[role="menu"]'));
    await key(rowEl(ID.scheduled).querySelector('[role="menuitem"]'), 'Escape');
    await key(mainButton(ID.scheduled), 's');
    await settle();
    assert.deepEqual(callsTo('sendNow').map(c => c[1]), [ID.scheduled]);
  });

  test('a held key sends now or deletes once, not once per repeat', async () => {
    await mount();
    mainButton(ID.failed).focus();
    await key(mainButton(ID.failed), 's', { repeat: true });
    await key(mainButton(ID.failed), 'Delete', { repeat: true });
    await settle();
    assert.equal(callsTo('sendNow').length, 0);
    assert.equal(callsTo('cancel').length, 0);
  });

  test('Shift+F10 opens the menu, Escape closes it and gives focus back', async () => {
    await mount();
    const main = mainButton(ID.scheduled);
    main.focus();
    await key(main, 'F10', { shiftKey: true });
    const menu = document.querySelector('[role="menu"]');
    assert.equal(document.activeElement, menu.querySelector('[role="menuitem"]'));
    await key(document.activeElement, 'ArrowDown');
    assert.equal(document.activeElement.dataset.scheduledAction, 'reschedule');
    await key(document.activeElement, 'Escape');
    assert.equal(document.querySelector('[role="menu"]'), null);
    assert.equal(document.activeElement, main);
  });
});

describe('phone', () => {
  test('a More button of 44 px opens an action sheet of 52 px rows; Reschedule opens the times sheet', async () => {
    await mount({ mobile: true });
    const more = rowEl(ID.scheduled).querySelector('[data-scheduled-more]');
    assert.equal(more.style.width, '44px');
    assert.equal(more.style.height, '44px');
    await click(more);
    const sheet = document.querySelector('[data-scheduled-sheet]');
    assert.equal(sheet.getAttribute('aria-modal'), 'true');
    const buttons = [...sheet.querySelectorAll('[data-scheduled-action]')];
    assert.deepEqual(buttons.map(b => b.dataset.scheduledAction), ['edit', 'reschedule', 'sendNow', 'cancel', 'delete']);
    assert.ok(buttons.every(b => b.style.minHeight === '52px'));
    await click(buttons[1]);
    const times = document.querySelector('[role="dialog"][aria-modal="true"]');
    assert.ok(times.textContent.includes('scheduled.actions.reschedule'));
    await click(times.querySelector('[data-preset="tomorrowAfternoon"]'));
    await settle();
    assert.equal(new Date(callsTo('reschedule')[0][2].sendAt).getHours(), 13);
  });

  test('a long press opens the sheet without editing; a tap edits', async () => {
    await mount({ mobile: true });
    const main = mainButton(ID.failed);
    await React.act(async () => {
      main.dispatchEvent(new window.Event('touchstart', { bubbles: true }));
      await new Promise(r => setTimeout(r, 560));
      main.dispatchEvent(new window.Event('touchend', { bubbles: true }));
      main.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    });
    assert.ok(document.querySelector('[data-scheduled-sheet]'));
    assert.equal(callsTo('get').length, 0);
    await click(document.querySelector('[data-scheduled-sheet]').querySelector('button:last-child'));
    await click(mainButton(ID.failed));
    await settle();
    assert.deepEqual(callsTo('get').map(c => c[1]), [ID.failed]);
  });
});

test('a notification link highlights its message and focuses it', async () => {
  await mount({ state: { scheduledHighlight: ID.paused } });
  await settle();
  assert.equal(document.activeElement, mainButton(ID.paused));
  assert.equal(mainButton(ID.paused).style.background, 'var(--accent-dim)');
});

describe('deleted messages', () => {
  const DELETED = '10000000-0000-4000-8000-000000000008';
  const EXPIRED = '10000000-0000-4000-8000-000000000009';
  const withDeleted = (restoreUntil) => () => {
    const list = structuredClone(LIST);
    list.messages.push(
      { ...base, id: DELETED, status: 'cancelled', sendAt: future(1), restoreUntil, summary: summary('Deleted one') },
      { ...base, id: EXPIRED, status: 'cancelled', sendAt: future(1), restoreUntil: future(-0.001), summary: summary('Gone') },
    );
    return list;
  };

  test('are listed last, without a count, while they can be restored; Restore and Delete for good', async () => {
    answers.list = withDeleted(future(0.005));
    await mount();
    const sections = [...document.querySelectorAll('[data-scheduled-section]')];
    assert.equal(sections.at(-1).dataset.scheduledSection, 'deleted');
    assert.equal(sections.at(-1).querySelector('h3').textContent, 'scheduled.sections.deleted');
    assert.ok(rowEl(DELETED));
    assert.equal(rowEl(EXPIRED), null, 'one whose window closed is not shown');
    assert.equal(rowEl(DELETED).querySelector('[data-scheduled-chip]').textContent, 'scheduled.chip.deleted');
    assert.match(rowEl(DELETED).textContent, /scheduled\.reason\.deleted:\{"when":/);
    await React.act(async () => {
      rowEl(DELETED).dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
    });
    assert.deepEqual([...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map(b => b.dataset.scheduledAction), ['restore', 'delete']);
    await click(document.querySelector('[role="menu"] [data-scheduled-action="restore"]'));
    await settle();
    assert.deepEqual(callsTo('restore'), [['restore', DELETED]]);
    assert.match(notifications()[0].title, /^compose\.scheduleSend\.scheduledFor/);
  });

  test('a restore that comes back paused says so', async () => {
    answers.list = withDeleted(future(0.005));
    answers.restore = { status: 'paused', sendAt: future(-0.01), pauseReason: 'user' };
    await mount();
    await hover(DELETED);
    await click(action(DELETED, 'restore'));
    await settle();
    assert.equal(notifications()[0].title, 'scheduled.toast.restoredPaused');
  });

  test('leave the list when their window closes', async () => {
    answers.list = withDeleted(new Date(Date.now() + 300).toISOString());
    await mount();
    assert.ok(rowEl(DELETED));
    await React.act(async () => { await new Promise(r => setTimeout(r, 450)); });
    assert.equal(rowEl(DELETED), null);
  });
});

test('a link to a message not in the list fetches it once more, then says it was not found', async () => {
  const missing = '10000000-0000-4000-8000-0000000000ff';
  await mount({ state: { scheduledHighlight: missing } });
  await settle();
  await settle();
  assert.ok(callsTo('list').length >= 2, 'fetched again');
  assert.equal(useStore.getState().scheduledHighlight, null);
  assert.equal(notifications()[0].title, 'scheduled.errors.linkNotFound');
});

describe('review nits', () => {
  test('an open menu closes when its row leaves the list', async () => {
    await mount();
    await React.act(async () => {
      rowEl(ID.failed).dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
    });
    assert.ok(document.querySelector('[role="menu"]'));
    const list = structuredClone(LIST);
    list.messages = list.messages.filter(m => m.id !== ID.failed);
    await React.act(async () => { useStore.getState().setScheduledList({ ...list, loadedAt: Date.now(), error: null }); });
    assert.equal(document.querySelector('[role="menu"]'), null);
  });

  test('a restore answered 404 (purged meanwhile) says it can no longer be restored', async () => {
    answers.restore = refusal(404, null, 'Scheduled message not found');
    await mount();
    await key(mainButton(ID.scheduled), 'Delete');
    await settle();
    await React.act(async () => { await notifications()[0].onUndo(); });
    assert.equal(notifications()[0].body, 'scheduled.errors.restoreExpired');
  });

  test('a link whose refetch fails clears the highlight and says not found', async () => {
    const missing = '10000000-0000-4000-8000-0000000000fe';
    answers.list = [structuredClone(LIST), new Error('offline')];
    await mount({ state: { scheduledHighlight: missing } });
    await settle();
    await settle();
    assert.equal(useStore.getState().scheduledHighlight, null);
    assert.equal(notifications()[0].title, 'scheduled.errors.linkNotFound');
  });
});

describe('details and superseded undos', () => {
  test('an uncertain row never says "try again"; a MailFlow explanation is labeled as the reason', async () => {
    answers.list = () => {
      const list = structuredClone(LIST);
      list.messages.find(m => m.id === ID.uncertain).failureDetail = 'Failed to send message. Please try again.';
      list.messages.find(m => m.id === ID.failed).failureDetail = 'The alias no longer exists.';
      return list;
    };
    await mount();
    assert.equal(rowEl(ID.uncertain).textContent.includes('try again'), false);
    assert.ok(rowEl(ID.failed).textContent.includes('scheduled.detail:{"detail":"The alias no longer exists."}'));
  });

  test('another action on a message dismisses the Undo still offered for it', async () => {
    await mount();
    await React.act(async () => {
      useStore.getState().addNotification({ title: 'scheduled', onUndo: () => {}, undoMs: 10_000, scheduledUndoFor: ID.scheduled });
      useStore.getState().addNotification({ title: 'other', onUndo: () => {}, undoMs: 10_000, scheduledUndoFor: ID.failed });
    });
    await hover(ID.scheduled);
    await click(action(ID.scheduled, 'reschedule'));
    await click(rowEl(ID.scheduled).querySelector('[data-preset="tomorrowMorning"]'));
    await settle();
    const titles = notifications().map(n => n.title);
    assert.equal(titles.includes('scheduled'), false, 'the schedule Undo for it is gone');
    assert.ok(titles.includes('other'), 'another message keeps its Undo');
  });

  test('a refused action leaves the Undo offered for the message', async () => {
    answers.reschedule = refusal(409, null, 'This message is being sent now.', { state: 'sending' });
    await mount();
    await React.act(async () => {
      useStore.getState().addNotification({ title: 'scheduled', onUndo: () => {}, undoMs: 10_000, scheduledUndoFor: ID.scheduled });
    });
    await hover(ID.scheduled);
    await click(action(ID.scheduled, 'reschedule'));
    await click(rowEl(ID.scheduled).querySelector('[data-preset="tomorrowMorning"]'));
    await settle();
    assert.ok(notifications().some(n => n.title === 'scheduled'));
  });
});
