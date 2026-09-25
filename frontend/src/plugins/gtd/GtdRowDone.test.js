import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as done from './inboxDone.js';

const doneInboxGtdMessage = done.doneInboxGtdMessage ?? (() => null);
const row = { id: 'one', account_id: 'acct', subject: 'One', unread_count: 3 };

function harness(reply = { ok: true }) {
  const events = [];
  const deps = {
    advance: id => events.push(['advance', id]),
    remove: id => events.push(['remove', id]),
    restore: rows => events.push(['restore', rows]),
    decrementUnread: (id, n) => events.push(['decrement', id, n]),
    incrementUnread: (id, n) => events.push(['increment', id, n]),
    gtdDone: async id => { events.push(['api', id]); if (reply instanceof Error) throw reply; return reply; },
    notify: notice => events.push(['notify', notice]),
    t: key => key,
  };
  return { deps, events };
}

describe('GTD main-list Done adapter', () => {
  it('advances, removes, and uses thread unread count before calling Done', async () => {
    const h = harness();
    await doneInboxGtdMessage(row, h.deps);
    assert.deepEqual(h.events.slice(0, 4), [['advance', 'one'], ['remove', 'one'], ['decrement', 'acct', 3], ['api', 'one']]);
  });

  it('preserves partial archive failure notification and rollback on request failure', async () => {
    const partial = harness({ archiveFailed: true });
    await doneInboxGtdMessage(row, partial.deps);
    assert.equal(partial.events.at(-1)[0], 'notify');
    const failed = harness(new Error('network'));
    await doneInboxGtdMessage(row, failed.deps);
    assert.ok(failed.events.some(([event]) => event === 'restore'));
    assert.ok(failed.events.some(([event]) => event === 'increment'));
  });
});
