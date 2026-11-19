import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { refreshListWindow, createTrailingRefresh, hasMoreRows, fetchListWindow, fetchPageOrLast } from './listRefresh.js';

describe('refreshListWindow (#682)', () => {
  test('a list that loaded 1 message still refreshes a whole page', () => {
    // A new account: the first load caught 1 message, then 8 more arrived. Refreshing with
    // limit=1 kept the list at one row until a reload.
    assert.deepEqual(refreshListWindow({ scrollMode: 'infinite', pageSize: 50, loadedCount: 1 }), { limit: 50, offset: 0 });
  });

  test('a short folder grows when new mail arrives', () => {
    assert.deepEqual(refreshListWindow({ scrollMode: 'infinite', pageSize: 50, loadedCount: 7 }), { limit: 50, offset: 0 });
  });

  test('an empty list refreshes a page', () => {
    assert.deepEqual(refreshListWindow({ scrollMode: 'infinite', pageSize: 25, loadedCount: 0 }), { limit: 25, offset: 0 });
  });

  test('keeps everything already scrolled into view', () => {
    assert.deepEqual(refreshListWindow({ scrollMode: 'infinite', pageSize: 50, loadedCount: 150 }), { limit: 150, offset: 0 });
  });

  test('keeps a window past the backend\'s 500-row page; fetchListWindow splits it (#743)', () => {
    assert.deepEqual(refreshListWindow({ scrollMode: 'infinite', pageSize: 50, loadedCount: 900 }), { limit: 900, offset: 0 });
  });

  test('paginated mode reloads the page on screen', () => {
    assert.deepEqual(refreshListWindow({ scrollMode: 'paginated', currentPage: 3, pageSize: 50, loadedCount: 2 }), { limit: 50, offset: 100 });
  });
});

describe('createTrailingRefresh (#682)', () => {
  test('a refresh during a load is held, then handed over once when the load settles', () => {
    const gate = createTrailingRefresh();
    assert.equal(gate.request(true), false, 'not run while loading');
    assert.equal(gate.request(true), false, 'several collapse into one');
    assert.equal(gate.settle(), true, 'run when the load finishes');
    assert.equal(gate.settle(), false, 'and only once');
  });

  test('a refresh with nothing loading runs at once and leaves nothing held', () => {
    const gate = createTrailingRefresh();
    assert.equal(gate.request(false), true);
    assert.equal(gate.settle(), false);
  });

  test('a refresh that ran after one was held clears the held one', () => {
    const gate = createTrailingRefresh();
    gate.request(true);
    assert.equal(gate.request(false), true);
    assert.equal(gate.settle(), false);
  });
});

// A server of `count` listable rows whose total (the folder counter) may say otherwise, and
// which caps a page at 500 as the backend does. Records every request.
function server(count, { total = count, shiftAfterFirst = 0 } = {}) {
  const calls = [];
  let shift = 0;
  const fetchPage = async ({ limit, offset }) => {
    calls.push({ limit, offset });
    assert.ok(limit <= 500, `asked for ${limit}, more than the backend serves`);
    const ids = Array.from({ length: count + shift }, (_, i) => ({ id: `r${i - shift}` }));
    const page = ids.slice(offset, offset + Math.min(limit, 500));
    shift += shiftAfterFirst; // mail arriving between parts pushes rows down
    return { messages: page, total: total + shift };
  };
  return { fetchPage, calls };
}

describe('hasMoreRows (#743)', () => {
  test('a full page under the total has more', () => {
    assert.equal(hasMoreRows({ fetched: 50, limit: 50, offset: 0, total: 120 }), true);
  });
  test('a short page is the end, whatever the folder counter says', () => {
    assert.equal(hasMoreRows({ fetched: 8, limit: 50, offset: 0, total: 10 }), false);
    assert.equal(hasMoreRows({ fetched: 0, limit: 50, offset: 50, total: 60 }), false);
  });
  test('a full page that reaches the total is the end', () => {
    assert.equal(hasMoreRows({ fetched: 50, limit: 50, offset: 50, total: 100 }), false);
  });
});

describe('fetchListWindow (#743)', () => {
  test('a 620-row window is fetched in two parts and keeps every row', async () => {
    const { fetchPage, calls } = server(800);
    const r = await fetchListWindow(fetchPage, { limit: 620 });
    assert.deepEqual(calls, [{ limit: 500, offset: 0 }, { limit: 120, offset: 500 }]);
    assert.equal(r.messages.length, 620);
    assert.equal(r.fetched, 620);
    assert.equal(r.hasMore, true);
  });
  test('a window within one page is one request', async () => {
    const { fetchPage, calls } = server(800);
    const r = await fetchListWindow(fetchPage, { limit: 150 });
    assert.deepEqual(calls, [{ limit: 150, offset: 0 }]);
    assert.equal(r.messages.length, 150);
  });
  test('stops at a short part, and a short part is the end', async () => {
    const { fetchPage, calls } = server(520, { total: 700 });
    const r = await fetchListWindow(fetchPage, { limit: 900 });
    assert.equal(calls.length, 2);
    assert.equal(r.messages.length, 520);
    assert.equal(r.hasMore, false, 'the counter says 700, the rows ended at 520');
  });
  test('a row pushed into the next part by new mail is kept once', async () => {
    const { fetchPage } = server(800, { shiftAfterFirst: 1 });
    const r = await fetchListWindow(fetchPage, { limit: 620 });
    const ids = r.messages.map(m => m.id);
    assert.equal(new Set(ids).size, ids.length, 'no duplicates');
    assert.equal(r.fetched, 620);
  });
});

describe('fetchPageOrLast (#743)', () => {
  test('a page with mail is served as asked', async () => {
    const { fetchPage, calls } = server(120);
    const r = await fetchPageOrLast(fetchPage, { page: 2, pageSize: 50 });
    assert.equal(r.page, 2);
    assert.equal(r.messages.length, 50);
    assert.equal(calls.length, 1);
  });
  test('an emptied last page moves back to the last page with mail', async () => {
    // Page 3 of 3 was on screen; its mail was deleted, leaving 100 rows.
    const { fetchPage } = server(100);
    const r = await fetchPageOrLast(fetchPage, { page: 3, pageSize: 50 });
    assert.equal(r.page, 2);
    assert.equal(r.messages.length, 50);
  });
  test('far past the end it goes straight to the last page', async () => {
    const { fetchPage, calls } = server(60);
    const r = await fetchPageOrLast(fetchPage, { page: 9, pageSize: 25 });
    assert.equal(r.page, 3);
    assert.equal(r.messages.length, 10);
    assert.equal(calls.length, 2);
  });
  test('a counter running ahead of the rows falls back to page 1, within three requests', async () => {
    const { fetchPage, calls } = server(10, { total: 500 });
    const r = await fetchPageOrLast(fetchPage, { page: 15, pageSize: 25 });
    assert.equal(r.page, 1);
    assert.equal(r.messages.length, 10);
    assert.ok(calls.length <= 3, `${calls.length} requests`);
  });
  test('an empty folder stops at page 1', async () => {
    const { fetchPage } = server(0);
    const r = await fetchPageOrLast(fetchPage, { page: 4, pageSize: 25 });
    assert.equal(r.page, 1);
    assert.deepEqual(r.messages, []);
  });
});
