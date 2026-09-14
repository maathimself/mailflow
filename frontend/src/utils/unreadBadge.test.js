import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { unreadBadge } from './unreadBadge.js';

describe('unreadBadge: the ghost badge it exists to prevent', () => {
  test('a stale count of zero renders nothing', () => {
    // The regression: four sidebar sites rendered on `count > 0 || stale`, so every folder and
    // account with no unread mail grew a badge each time its observation aged past the
    // freshness threshold, then lost it on the next observation. Collapsed, that badge is a
    // bare accent dot indistinguishable from new mail arriving.
    assert.equal(unreadBadge({ count: 0, stale: true }), null);
  });

  test('an unknown count renders nothing, however stale', () => {
    assert.equal(unreadBadge({ count: null, known: false, stale: true }), null);
    assert.equal(unreadBadge({ count: 4, known: false }), null,
      'a count we have not observed cannot justify an indicator, even a plausible one');
  });

  test('staleness alone never produces a badge at any of the shapes a caller can pass', () => {
    for (const count of [0, null, undefined, NaN, -1, '3', {}]) {
      assert.equal(unreadBadge({ count, stale: true }), null, `count=${String(count)} must render nothing`);
    }
  });
});

describe('unreadBadge: what it does show', () => {
  test('a real count renders plainly', () => {
    assert.deepEqual(unreadBadge({ count: 3 }), { text: '3', stale: false, title: 'Unread messages' });
  });

  test('staleness annotates a badge that already had a reason to exist', () => {
    const b = unreadBadge({ count: 3, stale: true });
    assert.equal(b.text, '~3');
    assert.equal(b.stale, true);
    assert.match(b.title, /Last observed/);
  });

  test('the stale title names the observation time when there is one', () => {
    const at = '2026-09-09T12:45:20.000Z';
    assert.ok(unreadBadge({ count: 1, stale: true, observedAt: at }).title.includes(new Date(at).toLocaleString()));
    assert.match(unreadBadge({ count: 1, stale: true }).title, /Last observed unread count; awaiting/,
      'no timestamp must not leave a dangling empty parenthesis');
  });

  test('clamps above max, keeping the stale marker outside the clamp', () => {
    assert.equal(unreadBadge({ count: 1000, max: 999 }).text, '999+');
    assert.equal(unreadBadge({ count: 1000, max: 999, stale: true }).text, '~999+');
    assert.equal(unreadBadge({ count: 999, max: 999 }).text, '999');
    assert.equal(unreadBadge({ count: 5 }).text, '5', 'no clamp when max is not given');
  });
});

describe('unreadBadge: degenerate input', () => {
  test('does not throw without arguments', () => {
    assert.equal(unreadBadge(), null);
    assert.equal(unreadBadge({}), null);
  });

  test('treats a folder row that predates the counts_known field as known', () => {
    // Rows served before the count work, or from a cache, carry no counts_known. Callers pass
    // `counts_known !== false`, so an absent field must not suppress a genuine count.
    assert.equal(unreadBadge({ count: 2, known: undefined }).text, '2');
  });
});
