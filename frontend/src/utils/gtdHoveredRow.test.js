import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  registerHoveredGtdRow,
  clearHoveredGtdRow,
  dispatchHoveredGtdShortcut,
} from './gtdHoveredRow.js';
import { canRunSelectedAction } from './shortcutApplicability.js';
import { classifyWithUndo } from './gtdClassification.js';

const row = { id: 'rail', account_id: 'gtd', thread_key: 'thread', message_id: '<rail@example.invalid>' };
const base = {
  enabledPlugins: ['gtd'], accounts: [{ id: 'gtd', gtd_enabled: true }],
  selectedMessageId: null, messages: [], threadMessages: {}, rightSidebarHidden: false,
  gtdSections: { todo: { threads: [row] } },
};

function register(actions, message = row, sectionKey = 'todo') {
  return registerHoveredGtdRow({ message, sectionKey, ...actions });
}

describe('hovered GTD row shortcuts', () => {
  it('routes Todo, Watch, and archive to the live hovered row without a selection', () => {
    const calls = [];
    const token = register({
      classify: (message, kind) => calls.push(['classify', message.id, kind]),
      archive: (message, states) => calls.push(['archive', message.id, states]),
    });
    try {
      for (const action of ['gtdTodo', 'gtdWatch', 'archive']) {
        assert.equal(canRunSelectedAction(action, base), true, action);
        assert.equal(dispatchHoveredGtdShortcut(action, base), true, action);
      }
      assert.deepEqual(calls, [
        ['classify', 'rail', 'todo'], ['classify', 'rail', 'watch'], ['archive', 'rail', ['todo']],
      ]);
    } finally { clearHoveredGtdRow(token); }
  });

  it('leaves other actions and normal selected-row routing alone', () => {
    const token = register({
      classify: () => assert.fail('unsupported action classified hover'),
      archive: () => assert.fail('unsupported action archived hover'),
    });
    try {
      assert.equal(dispatchHoveredGtdShortcut('gtdDelegated', base), false);
      assert.equal(dispatchHoveredGtdShortcut('toggleStar', base), false);
      assert.equal(canRunSelectedAction('gtdReference', base), false);
    } finally { clearHoveredGtdRow(token); }
    assert.equal(dispatchHoveredGtdShortcut('gtdTodo', base), false);
    assert.equal(canRunSelectedAction('gtdTodo', base), false);
  });

  it('does not let an older row clear the row that most recently took hover', () => {
    const calls = [];
    const first = register({ classify: () => calls.push('first') });
    const second = register({ classify: (_message, kind) => calls.push(`second:${kind}`) });
    try {
      assert.equal(clearHoveredGtdRow(first), false);
      assert.equal(dispatchHoveredGtdShortcut('gtdTodo', base), true);
      assert.deepEqual(calls, ['second:todo']);
    } finally { clearHoveredGtdRow(second); }
  });

  it('rejects hidden, disabled, removed, and cross-account sidebar targets', () => {
    const calls = [];
    const token = register({
      classify: () => calls.push('classify'),
      archive: () => calls.push('archive'),
    });
    const ineligible = [
      { ...base, rightSidebarHidden: true },
      { ...base, enabledPlugins: [] },
      { ...base, accounts: [{ id: 'gtd', gtd_enabled: false }] },
      { ...base, gtdSections: { todo: { threads: [] } } },
      { ...base, gtdSections: { reference: { threads: [row] } } },
      { ...base, gtdSections: { todo: { threads: [{ ...row, account_id: 'other' }] } } },
    ];
    try {
      for (const state of ineligible) {
        assert.equal(dispatchHoveredGtdShortcut('gtdTodo', state), false);
        assert.equal(dispatchHoveredGtdShortcut('archive', state), false);
        assert.equal(canRunSelectedAction('gtdWatch', state), false);
      }
      assert.deepEqual(calls, []);
    } finally { clearHoveredGtdRow(token); }
  });

  it('uses refreshed row metadata and current Waiting kinds while the pointer stays put', () => {
    const calls = [];
    const token = register({ archive: (message, states) => calls.push([message.subject, states]) }, row, 'waiting');
    const fresh = { ...row, subject: 'Refreshed', gtdKinds: ['watch', 'delegated'] };
    const state = { ...base, gtdSections: {
      watch: { threads: [fresh] }, delegated: { threads: [{ ...fresh, id: 'other-copy' }] },
    } };
    try {
      assert.equal(dispatchHoveredGtdShortcut('archive', state), true);
      assert.deepEqual(calls, [['Refreshed', ['watch', 'delegated']]]);
    } finally { clearHoveredGtdRow(token); }
  });

  it('suppresses hovered Done while classification may remove that copy', async () => {
    let finish;
    let done = 0;
    const pending = classifyWithUndo(row.id, 'watch', {
      api: { gtdClassify: () => new Promise(resolve => { finish = resolve; }) },
      store: { scheduleGtdSectionsFetch() {}, addNotification() {} }, t: key => key, message: row,
    });
    const token = register({ archive: () => { done += 1; } });
    try {
      dispatchHoveredGtdShortcut('archive', base);
      assert.equal(done, 0);
    } finally {
      finish({});
      await pending;
      clearHoveredGtdRow(token);
    }
  });
});
