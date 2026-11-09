// Dates in MailFlow's language, not the browser's (#593).
import { test, describe, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import i18next from 'i18next';
import { appLocale, appTimeFormat, formatDate, formatMessageDateTime, formatDateTime, formatDay, formatTime, formatSnoozeUntil } from './formatDate.js';

const at = (daysAgo, h = 15, m = 5) => { const d = new Date(); d.setDate(d.getDate() - daysAgo); d.setHours(h, m, 0, 0); return d; };
const aYearAgo = () => { const d = new Date(); d.setFullYear(d.getFullYear() - 1, 9, 12); d.setHours(15, 5, 0, 0); return d; };
afterEach(() => { i18next.language = undefined; });

describe('appLocale', () => {
  test('follows the language chosen in MailFlow, mapped to a BCP 47 tag', () => {
    for (const [code, tag] of [['ru', 'ru'], ['de', 'de'], ['ptBR', 'pt-BR'], ['zhCN', 'zh-CN']]) {
      i18next.language = code;
      assert.equal(appLocale(), tag);
    }
    i18next.language = undefined;
    assert.equal(appLocale(), 'en');
  });
});

describe('formatDate, the list label', () => {
  test('English reads as it always did', () => {
    assert.equal(formatDate(at(0), 'en'), '3:05 PM');
    assert.equal(formatDate(at(1), 'en'), 'Yesterday');
    assert.match(formatDate(aYearAgo(), 'en'), /^Oct 12, \d{4}$/);
  });
  test('Russian: Russian month and word for yesterday, 24-hour time, no AM/PM', () => {
    i18next.language = 'ru';
    assert.equal(formatDate(at(0)), '15:05');
    assert.equal(formatDate(at(1)), 'Вчера');
    assert.match(formatDate(aYearAgo()), /окт/);
    assert.doesNotMatch(formatDate(aYearAgo()), /Oct|PM|AM/);
  });
  test('German and Chinese', () => {
    assert.equal(formatDate(at(1), 'de'), 'Gestern');
    assert.equal(formatDate(at(1), 'zh-CN'), '昨天');
  });
  test('an invalid date gives nothing rather than throwing', () => {
    assert.equal(formatDate('not a date'), '');
    assert.equal(formatDate(null), '');
  });
});

describe('the other date surfaces', () => {
  test('the reading pane, with and without the year', () => {
    const d = aYearAgo();
    assert.match(formatMessageDateTime(d, {}, 'en'), /^Oct 12, \d{4}, 3:05 PM$/);
    assert.match(formatMessageDateTime(d, { withYear: false }, 'en'), /^Oct 12, 3:05 PM$/);
    i18next.language = 'ru';
    assert.match(formatMessageDateTime(d), /окт/);
    assert.match(formatMessageDateTime(d), /15:05/);
  });
  test('full dates in settings and conversations follow the app language too', () => {
    const d = aYearAgo();
    i18next.language = 'de';
    assert.equal(formatDay(d), d.toLocaleDateString('de'));
    assert.equal(formatDateTime(d), d.toLocaleString('de'));
    assert.equal(formatDay('nope'), '');
  });
});

describe('formatSnoozeUntil, when snoozed mail comes back (#269)', () => {
  const ahead = (days, h = 9, m = 0) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(h, m, 0, 0); return d; };
  test('the time today, Tomorrow and the time, the weekday within the week, the date beyond', () => {
    const later = new Date(); later.setMinutes(later.getMinutes() + 5);
    assert.match(formatSnoozeUntil(later, 'en'), /^\d{1,2}:\d{2}\s?[AP]M$/);
    assert.equal(formatSnoozeUntil(ahead(1), 'en'), 'Tomorrow 9:00 AM');
    assert.match(formatSnoozeUntil(ahead(3), 'en'), /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) 9:00\s?AM$/);
    assert.match(formatSnoozeUntil(ahead(20), 'en'), /^[A-Z][a-z]{2} \d{1,2}, 9:00\s?AM$/);
  });
  test('in the app language', () => {
    assert.match(formatSnoozeUntil(ahead(1), 'de'), /^Morgen 0?9:00$/);
  });
  test('nothing for a missing or broken value', () => {
    assert.equal(formatSnoozeUntil(null, 'en'), '');
    assert.equal(formatSnoozeUntil('nope', 'en'), '');
  });
});

describe('the time format setting (#758)', () => {
  const store = new Map();
  const realLocalStorage = globalThis.localStorage;
  beforeEach(() => {
    store.clear();
    globalThis.localStorage = {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    };
  });
  afterEach(() => {
    if (realLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = realLocalStorage;
    i18next.language = undefined;
  });
  const ahead = (days, h = 9, m = 0) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(h, m, 0, 0); return d; };

  test('Automatic follows the language, as before', () => {
    assert.equal(appTimeFormat(), 'auto');
    assert.equal(formatDate(at(0), 'en'), '3:05 PM');
    i18next.language = 'ru';
    assert.equal(formatDate(at(0)), '15:05');
  });
  test('12-hour forces a 12-hour clock even in a 24-hour language', () => {
    globalThis.localStorage.setItem('mailflow_time_format', '12');
    assert.equal(appTimeFormat(), '12');
    i18next.language = 'ru';
    assert.equal(formatDate(at(0)), '3:05 PM');
    assert.match(formatMessageDateTime(aYearAgo(), {}, 'ru'), /3:05\s?PM/);
    assert.equal(formatTime(at(0), 'en'), '3:05 PM');
    assert.match(formatDateTime(aYearAgo(), 'ru'), /3:05\s?PM/);
  });
  test('24-hour forces a 24-hour clock even in a 12-hour language', () => {
    globalThis.localStorage.setItem('mailflow_time_format', '24');
    assert.equal(appTimeFormat(), '24');
    assert.equal(formatDate(at(0), 'en'), '15:05');
    assert.match(formatMessageDateTime(aYearAgo(), {}, 'en'), /15:05/);
    assert.doesNotMatch(formatMessageDateTime(aYearAgo(), {}, 'en'), /PM/);
    assert.equal(formatTime(at(0), 'en'), '15:05');
    // A 24-hour clock pads the hour, as German does today ("Morgen 09:00").
    assert.equal(formatSnoozeUntil(ahead(1), 'en'), 'Tomorrow 09:00');
  });
  test('an unknown stored value falls back to Automatic', () => {
    globalThis.localStorage.setItem('mailflow_time_format', '13');
    assert.equal(appTimeFormat(), 'auto');
    assert.equal(formatDate(at(0), 'en'), '3:05 PM');
  });
  test('date-only shapes are untouched by the setting', () => {
    globalThis.localStorage.setItem('mailflow_time_format', '24');
    assert.match(formatDate(aYearAgo(), 'en'), /^Oct 12, \d{4}$/);
    assert.equal(formatDay(aYearAgo(), 'en'), aYearAgo().toLocaleDateString('en'));
  });
});
