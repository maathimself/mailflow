import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as hotkeys from './hotkeys.js';

const resolveGtdHotkeyTarget = hotkeys.resolveGtdHotkeyTarget ?? (() => null);
const runGtdHotkey = hotkeys.runGtdHotkey ?? (() => false);

const inbox = { id: 'inbox', account_id: 'gtd', is_read: false };
const rail = { id: 'rail', account_id: 'gtd', message_id: '<one>', gtdKinds: ['watch', 'delegated'] };
const sections = { watch: { threads: [rail] }, delegated: { threads: [{ ...rail, id: 'other-copy' }] } };
const base = { enabledPlugins: ['gtd'], accounts: [{ id: 'gtd', gtd_enabled: true }, { id: 'ordinary', gtd_enabled: false }], messages: [inbox], searchResults: [], searchQuery: '', threadMessages: {}, gtdSections: sections };

describe('GTD hotkey target', () => {
  it('uses main-list Done semantics for an ordinary selected row', () => {
    assert.deepEqual(resolveGtdHotkeyTarget({ ...base, selectedMessageId: 'inbox' }), { message: inbox, surface: 'main', states: null });
  });

  it('uses section-scoped Done for tab and rail rows absent from messages', () => {
    const tab = resolveGtdHotkeyTarget({ ...base, selectedMessageId: 'rail', activeGtdTab: 'waiting' });
    assert.equal(tab?.surface, 'rail');
    assert.deepEqual(tab?.states, ['watch', 'delegated']);
    const sidebar = resolveGtdHotkeyTarget({ ...base, selectedMessageId: 'rail', activeGtdTab: null }, { id: 'rail', sectionKey: 'waiting' });
    assert.equal(sidebar?.message.id, 'rail');
    assert.deepEqual(sidebar?.states, ['watch', 'delegated']);
  });

  it('keeps rail scope when a stale rail id opens a recovered copy', () => {
    const recovered = { ...rail, id: 'recovered' };
    const target = resolveGtdHotkeyTarget({
      ...base, selectedMessageId: 'recovered',
      threadMessages: { __dl_recovered: [recovered] },
    }, { id: 'rail', messageId: '<one>', sectionKey: 'waiting' });
    assert.equal(target?.surface, 'rail');
    assert.equal(target?.message.id, 'recovered');
    assert.deepEqual(target?.states, ['watch', 'delegated']);
  });

  it('gates no selection, inactive plugin, and non-GTD accounts', () => {
    assert.equal(resolveGtdHotkeyTarget({ ...base, selectedMessageId: null }), null);
    assert.equal(resolveGtdHotkeyTarget({ ...base, enabledPlugins: [], selectedMessageId: 'inbox' }), null);
    assert.equal(resolveGtdHotkeyTarget({ ...base, messages: [{ ...inbox, account_id: 'ordinary' }], selectedMessageId: 'inbox' }), null);
  });
});

describe('GTD shortcut execution', () => {
  it('classifies Reference and Someday from a selected GTD rail copy', async () => {
    const calls = [];
    const state = { ...base, selectedMessageId: 'rail', activeGtdTab: 'waiting' };
    const deps = { classify: (id, kind) => calls.push([id, kind]) };
    await runGtdHotkey('gtdReference', state, deps);
    await runGtdHotkey('gtdSomeday', state, deps);
    assert.deepEqual(calls, [['rail', 'reference'], ['rail', 'someday']]);
  });

  it('routes Done to main or rail checkmark semantics and gates non-GTD account', async () => {
    const calls = [];
    const deps = {
      doneMain: message => calls.push(['main', message.id]),
      doneRail: (message, states) => calls.push(['rail', message.id, states]),
    };
    await runGtdHotkey('gtdDone', { ...base, selectedMessageId: 'inbox' }, deps);
    await runGtdHotkey('gtdDone', { ...base, selectedMessageId: 'rail', activeGtdTab: 'waiting' }, deps);
    await runGtdHotkey('gtdDone', { ...base, messages: [{ ...inbox, account_id: 'ordinary' }], selectedMessageId: 'inbox' }, deps);
    assert.deepEqual(calls, [['main', 'inbox'], ['rail', 'rail', ['watch', 'delegated']]]);
  });
});
