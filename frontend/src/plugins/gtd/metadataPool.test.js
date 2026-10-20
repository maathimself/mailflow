import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectGtdMetadataMessages } from './metadataPool.js';

const row = (id, account_id = 'a', thread_id = 'thread') => ({ id, account_id, thread_id });
const base = {
  user: { id: 'user' }, accounts: [{ id: 'a', gtd_enabled: true }, { id: 'b', gtd_enabled: true }],
  selectedFolder: 'INBOX', searchQuery: '', activeGtdTab: null,
  messages: [row('listed')], searchResults: [], selectedMessageId: null,
  threadMessages: {}, messageWindows: [],
};
const ids = state => collectGtdMetadataMessages(state).map(message => message.id);

test('selected rows and their loaded thread survive every list visibility gate', () => {
  for (const selectedFolder of ['INBOX', 'Sent', 'Custom/Next', null]) {
    for (const activeGtdTab of [null, 'todo', 'watch', 'delegated', 'reference', 'someday']) {
      const state = { ...base, selectedFolder, activeGtdTab, selectedMessageId: 'member',
        threadMessages: { thread: [row('member'), row('reply')], other: [row('other', 'b')] } };
      assert.deepEqual(ids(state), selectedFolder === 'INBOX' && !activeGtdTab
        ? ['listed', 'member', 'reply'] : ['member', 'reply']);
    }
  }
});

test('search and detached panes resolve actual rows without substituting account/thread identities', () => {
  assert.deepEqual(ids({ ...base, selectedFolder: 'Sent', searchQuery: 'match',
    searchResults: [row('search', 'b')], selectedMessageId: 'search',
    messageWindows: [{ messageId: 'window' }, { messageId: 'missing' }],
    threadMessages: { parked: [row('window')], unrelated: [row('other', 'b', 'other-thread')] },
  }), ['search', 'window']);
  assert.deepEqual(ids({ ...base, selectedFolder: 'Sent', selectedMessageId: 'listed',
    threadMessages: { reusedKey: [row('other', 'b')] } }), ['listed']);
});

test('missing selection, user, and disabled accounts cannot contribute metadata', () => {
  assert.deepEqual(ids({}), []);
  assert.deepEqual(ids({ ...base, user: null }), []);
  assert.deepEqual(ids({ ...base, selectedMessageId: 'listed', accounts: [{ id: 'a', gtd_enabled: false }] }), []);
  assert.deepEqual(ids({ ...base, selectedFolder: 'Sent', selectedMessageId: 'missing' }), []);
});

test('generated pool membership agrees with eligibility across gates, accounts and source permutations', () => {
  for (let mask = 0; mask < 256; mask += 1) {
    const search = Boolean(mask & 1), inbox = Boolean(mask & 2), tab = Boolean(mask & 4);
    const enabledA = Boolean(mask & 8), enabledB = Boolean(mask & 16);
    const selected = Boolean(mask & 32), window = Boolean(mask & 64), reverse = Boolean(mask & 128);
    const list = [row('z', 'a'), row('a', 'b')];
    const state = { ...base, accounts: [{ id: 'a', gtd_enabled: enabledA }, { id: 'b', gtd_enabled: enabledB }],
      selectedFolder: inbox ? 'INBOX' : 'Custom/Label', activeGtdTab: tab ? 'watch' : null,
      searchQuery: search ? 'term' : '', messages: reverse ? list.toReversed() : list,
      searchResults: reverse ? list : list.toReversed(), selectedMessageId: selected ? 'member' : null,
      threadMessages: { actual: [row('member'), row('reply')], parked: [row('window', 'b')] },
      messageWindows: window ? [{ messageId: 'window' }, { messageId: 'window', z: mask }] : [] };
    const expected = [];
    if (search || (inbox && !tab)) { if (enabledA) expected.push('z'); if (enabledB) expected.push('a'); }
    if (selected && enabledA) expected.push('member', 'reply');
    if (window && enabledB) expected.push('window');
    const before = structuredClone(state);
    assert.deepEqual(ids(state), expected.sort(), `case ${mask}`);
    assert.deepEqual(state, before, 'pool collection is pure');
  }
});

test('identity output is stable under in-thread navigation, row churn and window geometry', () => {
  const state = { ...base, selectedMessageId: 'listed', threadMessages: { thread: [row('listed'), row('member')] },
    messageWindows: [{ messageId: 'member' }] };
  const expected = collectGtdMetadataMessages(state);
  assert.deepEqual(collectGtdMetadataMessages({ ...state, selectedMessageId: 'member',
    messages: [{ ...state.messages[0], is_read: true, snippet: 'changed' }],
    messageWindows: [{ messageId: 'member', x: 400, z: 10, minimized: true }] }), expected);
  assert.deepEqual(expected, ['listed', 'member'].map(id => ({ id, account_id: 'a', thread_key: 'thread', message_id: undefined })));
});

test('active-list provenance wins over every overlapping stale stash and duplicate window', () => {
  const live = { ...row('listed'), message_id: '<live>', thread_id: 'live' };
  const stale = { ...live, message_id: '<stale>', thread_id: 'stale' };
  for (const groups of [{ old: [stale], duplicate: [stale] }, { duplicate: [stale], old: [stale] }]) {
    for (const messageWindows of [[], [{ messageId: live.id }], [{ messageId: live.id }, { messageId: live.id }]]) {
      for (const searchQuery of ['', '   ', 'match']) {
        assert.deepEqual(collectGtdMetadataMessages({ ...base, searchQuery, messages: searchQuery.trim() ? [stale] : [live],
          searchResults: searchQuery.trim() ? [live] : [stale], selectedFolder: 'Sent',
          selectedMessageId: live.id, threadMessages: groups, messageWindows }),
        [{ id: live.id, account_id: 'a', thread_key: 'live', message_id: '<live>' }]);
      }
    }
  }
});

test('search resolution ignores inactive rows and real mixed-account threads retain enabled copies', () => {
  const selected = row('selected');
  assert.deepEqual(ids({ ...base, searchQuery: 'match', searchResults: [selected], messages: [row('inactive')],
    selectedMessageId: 'selected', threadMessages: { actual: [selected, row('copy', 'b')], separate: [row('separate', 'b')] } }), ['copy', 'selected']);
  assert.deepEqual(ids({ ...base, searchQuery: '   ', searchResults: [row('inactive')], selectedMessageId: 'listed',
    threadMessages: { thread: [{ id: 'member', account_id: 'a' }] } }), ['listed', 'member']);
});
