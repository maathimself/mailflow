// Run with: node --test src/plugins/gtd/movePickerSections.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildGtdMovePickerSections, GTD_PICKER_ORDER } from './movePickerSections.js';

const t = (k) => k;
const noop = () => {};
const deps = (over = {}) => ({ classifyOne: noop, classifyMany: noop, renderStateIcon: noop, ...over });
const ctx = (over = {}) => ({
  account: { gtd_enabled: true },
  messages: [{ id: 1 }],
  currentFolder: 'INBOX',
  onClose: noop,
  t,
  ...over,
});

describe('buildGtdMovePickerSections', () => {
  it('returns nothing when the account has GTD off', () => {
    assert.deepEqual(buildGtdMovePickerSections(ctx({ account: { gtd_enabled: false } }), deps()), []);
    assert.deepEqual(buildGtdMovePickerSections(ctx({ account: undefined }), deps()), []);
  });

  it('returns nothing when no messages are picked', () => {
    assert.deepEqual(buildGtdMovePickerSections(ctx({ messages: [] }), deps()), []);
    assert.deepEqual(buildGtdMovePickerSections(ctx({ messages: undefined }), deps()), []);
  });

  it('lists states in picker order with default paths', () => {
    const [section] = buildGtdMovePickerSections(ctx(), deps());
    assert.equal(section.key, 'gtd');
    assert.equal(section.heading, 'gtd.title');
    assert.deepEqual(GTD_PICKER_ORDER, ['todo', 'delegated', 'watch', 'reference', 'someday']);
    assert.deepEqual(section.items.map(i => i.key), ['todo', 'delegated', 'watch', 'reference', 'someday']);
    assert.deepEqual(section.items.map(i => i.path), ['Todo', 'Delegated', 'Watch', 'Reference', 'Someday']);
    assert.deepEqual(section.items.map(i => i.label), [
      'gtd.state.todo', 'gtd.state.delegated', 'gtd.state.watch', 'gtd.state.reference', 'gtd.state.someday',
    ]);
  });

  it('uses renamed folders', () => {
    const [section] = buildGtdMovePickerSections(
      ctx({ account: { gtd_enabled: true, gtd_folders: { todo: '@Next' } } }), deps());
    assert.equal(section.items.find(i => i.key === 'todo').path, '@Next');
    assert.equal(section.items.find(i => i.key === 'watch').path, 'Watch');
  });

  it('one message tags through classifyOne, several through classifyMany', () => {
    const one = [];
    const many = [];
    const spies = deps({
      classifyOne: (...args) => { one.push(args); },
      classifyMany: (...args) => { many.push(args); },
    });
    const message = { id: 7 };
    const [single] = buildGtdMovePickerSections(ctx({ messages: [message] }), spies);
    single.items.find(i => i.key === 'watch').onSelect();
    assert.deepEqual(one, [[message, 'watch']]);
    assert.deepEqual(many, []);

    const messages = [{ id: 1 }, { id: 2 }];
    const [bulk] = buildGtdMovePickerSections(ctx({ messages }), spies);
    bulk.items.find(i => i.key === 'watch').onSelect();
    assert.equal(one.length, 1);
    assert.equal(many.length, 1);
    assert.equal(many[0][0], messages);
    assert.equal(many[0][1], 'watch');
  });

  it('a bulk pick tags the rows as selected, without expanding threads', () => {
    const many = [];
    const messages = [{ id: 1, thread_key: 't1', thread_count: 3 }, { id: 2, thread_key: 't2' }];
    const [bulk] = buildGtdMovePickerSections(ctx({ messages }), deps({
      classifyMany: (...args) => { many.push(args); },
    }));
    bulk.items.find(i => i.key === 'todo').onSelect();
    assert.equal(many.length, 1);
    assert.equal(many[0][0], messages);
    assert.deepEqual(many[0][0].map(m => m.id), [1, 2]);
  });

  it('renderIcon passes state and size through', () => {
    const calls = [];
    const [section] = buildGtdMovePickerSections(ctx(), deps({
      renderStateIcon: (...args) => { calls.push(args); return 'icon'; },
    }));
    assert.equal(section.items[0].renderIcon(18), 'icon');
    assert.deepEqual(calls, [['todo', 18]]);
  });
});
