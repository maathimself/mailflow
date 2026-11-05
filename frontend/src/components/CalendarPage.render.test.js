// Render test for the calendar page: the empty state, the week view with a failed account's
// banner, the event popover (plain text only), the recurring-event questions and the requests
// they make, a 409 conflict, the calendar checkboxes, and the phone layout.
//
// Mounted the way ScheduledList.render.test.js mounts its view.

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
const CalendarPage = (await import('./CalendarPage.jsx')).default;

const pad = (n) => String(n).padStart(2, '0');
const now = new Date();
const todayKey = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
const at = (h, m = 0) => new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m).toISOString();

const ACCOUNT = { id: 'a1', name: 'Fastmail', serverUrl: 'https://dav.example.invalid', username: 'me', intervalMin: 15, lastSyncAt: '2026-11-05T08:00:00.000Z', lastError: null, calendarCount: 2, eventCount: 3 };
const CALS = [
  { id: 'c1', accountId: 'a1', accountName: 'Fastmail', name: 'Personal', color: '#4f8df7', visible: true, readOnly: false },
  { id: 'c2', accountId: 'a1', accountName: 'Fastmail', name: 'Holidays', color: '#e5548c', visible: true, readOnly: true },
];
const occ = (over) => ({
  id: 'e1:', eventId: 'e1', calendarId: 'c1', recurrenceId: null, summary: 'Standup', location: null, description: null, url: null,
  allDay: false, start: at(10), end: at(11), timezone: null, isRecurring: false, recurrence: null, recurrenceCustom: false,
  status: 'CONFIRMED', organizer: null, attendees: [], reminderMinutes: null, readOnly: false, ...over,
});
const EVENTS = [
  occ({ id: 'e1:', summary: 'Standup', description: 'Notes <script>alert(1)</script> see https://example.invalid/doc. javascript:alert(2)', location: 'Room 4', organizer: { name: 'Ana', email: 'ana@example.invalid' }, attendees: [{ name: 'Bo', email: 'bo@example.invalid', status: 'ACCEPTED' }] }),
  occ({ id: 'e2:R1', eventId: 'e2', recurrenceId: 'R1', summary: 'Gym', start: at(18), end: at(19), isRecurring: true, recurrence: { freq: 'WEEKLY', interval: 1, until: null, count: null }, reminderMinutes: 45 }),
  occ({ id: 'e3:', eventId: 'e3', calendarId: 'c2', summary: 'Bank holiday', allDay: true, start: todayKey, end: todayKey.slice(0, 8) + pad(now.getDate() + 1 > 28 ? 28 : now.getDate() + 1), readOnly: true }),
];

const calls = [];
let answers = {};
function answer(name, args) {
  calls.push([name, ...args]);
  const next = answers[name];
  const result = typeof next === 'function' ? next(...args) : next;
  return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
}
const callsTo = (name) => calls.filter(c => c[0] === name);
const refusal = (status, code, message = 'server words') => Object.assign(new Error(message), { status, ...(code ? { code } : {}) });

before(() => {
  for (const name of ['accounts', 'addAccount', 'updateAccount', 'syncAccount', 'removeAccount', 'calendars', 'updateCalendar', 'events', 'createEvent', 'updateEvent', 'deleteEvent']) {
    api.calendar[name] = (...a) => answer(name, a);
  }
});
beforeEach(() => {
  calls.length = 0;
  localStorage.clear();
  answers = {
    accounts: () => structuredClone([ACCOUNT]),
    calendars: () => structuredClone(CALS),
    events: () => ({ events: structuredClone(EVENTS) }),
    updateCalendar: (id, data) => ({ id, ...data }),
    updateEvent: { ok: true },
    createEvent: { ok: true, eventId: 'new' },
    deleteEvent: { ok: true },
  };
});

const settle = () => React.act(async () => { await new Promise(r => setTimeout(r, 5)); });
const click = (el) => React.act(async () => { el.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
const byText = (text, scope = document) => [...scope.querySelectorAll('button')].find(b => b.textContent.trim() === text);
const eventButton = (summary) => document.querySelector(`button[aria-label^="${summary}"]`);
const dialog = () => [...document.querySelectorAll('[role="dialog"]')].pop();

let root = null;
async function mount({ mobile = false } = {}) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: mobile ? 375 : 1280 });
  useStore.setState({ user: { id: 'u1' }, isLocked: false, showCalendar: true, showContacts: false });
  root = createRoot(document.getElementById('root'));
  await React.act(async () => { root.render(React.createElement(CalendarPage)); });
  await settle();
  await settle();
}
afterEach(async () => {
  await settle();
  if (root) await React.act(async () => root.unmount());
  root = null;
  document.body.innerHTML = '<div id="root"></div>';
});

describe('without an account', () => {
  test('explains the connection and opens the add form', async () => {
    answers.accounts = [];
    answers.calendars = [];
    await mount();
    assert.ok(document.body.textContent.includes('calendar.empty.title'));
    assert.ok(document.body.textContent.includes('calendar.empty.body'));
    assert.equal(callsTo('events').length, 0, 'no events are asked for without a calendar');
    await click(byText('calendar.empty.connect'));
    assert.ok(dialog().textContent.includes('calendar.accounts.googleHint'));
    assert.ok(dialog().textContent.includes('calendar.accounts.appPasswordHint'));
  });
});

describe('the week view', () => {
  test('shows events, the title, the rail and remembers the view', async () => {
    await mount();
    assert.ok(eventButton('Standup'), 'a timed event');
    assert.ok(eventButton('Gym'));
    assert.ok(document.querySelector('aside'), 'the rail on a desktop');
    assert.ok(document.body.textContent.includes('Personal') && document.body.textContent.includes('Fastmail'));
    assert.ok(document.body.textContent.includes('Bank holiday'), 'the all-day row');
    await click(byText('calendar.views.month'));
    assert.equal(localStorage.getItem('mailflow:calendar:view'), 'month');
    assert.ok(document.body.textContent.includes('Standup'));
  });

  test('does nothing while the page is hidden', async () => {
    useStore.setState({ showCalendar: false });
    root = createRoot(document.getElementById('root'));
    await React.act(async () => { root.render(React.createElement(CalendarPage)); });
    await settle();
    assert.equal(calls.length, 0);
  });

  test('a failed account is shown as a banner with the server words', async () => {
    answers.accounts = [{ ...ACCOUNT, lastError: 'Invalid credentials' }];
    await mount();
    const alert = [...document.querySelectorAll('[role="alert"]')].find(a => a.textContent.includes('Invalid credentials'));
    assert.ok(alert);
    assert.ok(alert.textContent.includes('calendar.accounts.bannerTitle'));
    await click(byText('calendar.accounts.manage'));
    assert.ok(dialog().textContent.includes('calendar.accounts.syncFailed'));
  });

  test('a failed events request is visible and retryable', async () => {
    answers.events = refusal(500, null, 'boom');
    await mount();
    assert.ok(document.body.textContent.includes('calendar.errors.load:{"message":"boom"}'));
    assert.ok(byText('common.retry'));
  });

  test('unchecking a calendar hides its events and saves the preference', async () => {
    await mount();
    const box = [...document.querySelectorAll('[role="checkbox"]')].find(b => b.textContent.includes('Holidays'));
    await click(box);
    assert.deepEqual(callsTo('updateCalendar')[0], ['updateCalendar', 'c2', { visible: false }]);
    assert.equal(eventButton('Bank holiday'), null);
  });
});

describe('the event popover', () => {
  test('shows details as plain text and links only http addresses', async () => {
    await mount();
    await click(eventButton('Standup'));
    const d = dialog();
    assert.ok(d.textContent.includes('Room 4'));
    assert.ok(d.textContent.includes('Ana'));
    assert.ok(d.textContent.includes('calendar.attendee.accepted'));
    assert.ok(d.textContent.includes('<script>alert(1)</script>'), 'markup stays text');
    assert.equal(d.querySelector('script'), null);
    const links = [...d.querySelectorAll('a')];
    assert.deepEqual(links.map(a => a.getAttribute('href')), ['https://example.invalid/doc']);
    assert.ok(links[0].rel.includes('noopener'));
    assert.ok(d.textContent.includes('javascript:alert(2)'));
  });

  test('a read-only event offers neither edit nor delete', async () => {
    await mount();
    await click(eventButton('Bank holiday'));
    assert.ok(dialog().textContent.includes('calendar.detail.readOnly'));
    assert.equal(byText('common.edit', dialog()), undefined);
    assert.equal(byText('common.delete', dialog()), undefined);
  });

  test('deleting a plain event asks first, then sends scope all', async () => {
    await mount();
    await click(eventButton('Standup'));
    await click(byText('common.delete', dialog()));
    assert.equal(callsTo('deleteEvent').length, 0);
    await click(byText('common.delete', dialog()));
    await settle();
    assert.deepEqual(callsTo('deleteEvent')[0], ['deleteEvent', 'e1', { scope: 'all', recurrenceId: undefined }]);
  });

  test('deleting one occurrence of a series asks which and names the occurrence', async () => {
    await mount();
    await click(eventButton('Gym'));
    await click(byText('common.delete', dialog()));
    assert.ok(dialog().textContent.includes('calendar.scope.deleteTitle'));
    await click(byText('calendar.scope.thisOne'));
    await settle();
    assert.deepEqual(callsTo('deleteEvent')[0], ['deleteEvent', 'e2', { scope: 'this', recurrenceId: 'R1' }]);
  });

  test('a failed delete says so in the popover and fetches again', async () => {
    answers.deleteEvent = refusal(502, null, 'upstream said no');
    await mount();
    const before = callsTo('events').length;
    await click(eventButton('Standup'));
    await click(byText('common.delete', dialog()));
    await click(byText('common.delete', dialog()));
    await settle();
    assert.ok(dialog().textContent.includes('calendar.errors.server:{"message":"upstream said no"}'));
    assert.ok(callsTo('events').length > before);
  });
});

describe('the event form', () => {
  const openEdit = async (summary) => {
    await click(eventButton(summary));
    await click(byText('common.edit', dialog()));
  };

  test('editing the whole series keeps the occurrence and sends the recurrence', async () => {
    await mount();
    await openEdit('Gym');
    await click(byText('calendar.scope.editAll'));
    assert.ok(dialog().textContent.includes('calendar.form.repeat'));
    await click(byText('common.save', dialog()));
    await settle();
    const [, id, body] = callsTo('updateEvent')[0];
    assert.equal(id, 'e2');
    assert.equal(body.scope, 'all');
    assert.equal(body.recurrenceId, 'R1');
    assert.deepEqual(body.recurrence, { freq: 'WEEKLY', interval: 1 });
    assert.equal(body.reminderMinutes, 45, 'a reminder the form has no preset for is kept');
    assert.equal(body.calendarId, 'c1');
  });

  test('editing one occurrence leaves the recurrence and the calendar out', async () => {
    await mount();
    await openEdit('Gym');
    await click(byText('calendar.scope.thisOne'));
    assert.equal(dialog().textContent.includes('calendar.form.repeat'), false);
    await click(byText('common.save', dialog()));
    await settle();
    const body = callsTo('updateEvent')[0][2];
    assert.equal(body.scope, 'this');
    assert.equal(body.recurrenceId, 'R1');
    assert.equal('recurrence' in body, false);
    assert.equal('calendarId' in body, false);
  });

  test('a custom rule is shown as Custom and not sent', async () => {
    answers.events = { events: [occ({ id: 'e4:', eventId: 'e4', summary: 'Odd', isRecurring: true, recurrenceCustom: true, recurrenceId: 'R9' })] };
    await mount();
    await openEdit('Odd');
    await click(byText('calendar.scope.editAll'));
    assert.ok(dialog().textContent.includes('calendar.recurrence.custom'));
    await click(byText('common.save', dialog()));
    await settle();
    assert.equal('recurrence' in callsTo('updateEvent')[0][2], false);
  });

  test('a 409 conflict is explained in the form, which stays open, and the events are fetched again', async () => {
    answers.updateEvent = refusal(409, 'conflict');
    await mount();
    const before = callsTo('events').length;
    await openEdit('Standup');
    await click(byText('common.save', dialog()));
    await settle();
    assert.ok(dialog().textContent.includes('calendar.errors.conflict'));
    assert.ok(callsTo('events').length > before);
  });

  test('a new event goes to the calendar chosen and refuses an empty title', async () => {
    await mount();
    await click(byText('calendar.newEvent'));
    const options = [...dialog().querySelectorAll('select')[0].options].map(o => o.value);
    assert.deepEqual(options, ['c1'], 'only writable calendars are offered');
    await click(byText('common.save', dialog()));
    assert.ok(dialog().textContent.includes('calendar.form.titleRequired'));
    assert.equal(callsTo('createEvent').length, 0);
    const input = dialog().querySelector('input');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    await React.act(async () => { setter.call(input, 'Dentist'); input.dispatchEvent(new window.Event('input', { bubbles: true })); });
    await click(byText('common.save', dialog()));
    await settle();
    const body = callsTo('createEvent')[0][1];
    assert.equal(body.summary, 'Dentist');
    assert.equal(body.calendarId, 'c1');
    assert.equal(body.allDay, false);
    assert.ok(body.timezone);
  });
});

describe('on a phone', () => {
  test('opens on the agenda with a new-event button and no rail', async () => {
    await mount({ mobile: true });
    assert.equal(document.querySelector('aside'), null);
    assert.ok(document.querySelector('button[aria-label="calendar.newEvent"]'));
    assert.ok(document.body.textContent.includes('Standup'));
    assert.equal(document.querySelector('button[aria-pressed="true"]').textContent, 'calendar.views.agenda');
  });

  test('the event opens as a sheet', async () => {
    await mount({ mobile: true });
    await click([...document.querySelectorAll('button')].find(b => b.textContent.includes('Standup')));
    assert.ok(dialog().textContent.includes('Room 4'));
  });
});
