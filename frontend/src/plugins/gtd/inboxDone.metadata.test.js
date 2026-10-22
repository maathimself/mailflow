import { it } from 'node:test';
import assert from 'node:assert/strict';
import { doneInboxGtdMessage } from './inboxDone.js';
import { getGtdMetadataRefreshGeneration } from './metadataStore.js';

it('refreshes indicators after main-list Done, including uncertain failures', async () => {
  const deps = { advance() {}, remove() {}, restore() {}, decrementUnread() {}, incrementUnread() {}, notify() {}, t: key => key, gtdDone: async () => ({ ok: true }) };
  const before = getGtdMetadataRefreshGeneration();
  await doneInboxGtdMessage({ id: 'message', is_read: true }, deps);
  assert.equal(getGtdMetadataRefreshGeneration(), before + 1);
  await doneInboxGtdMessage({ id: 'message', is_read: true }, { ...deps, gtdDone: async () => { throw new Error('offline'); } });
  assert.equal(getGtdMetadataRefreshGeneration(), before + 2);
});

it('refreshes indicators after main-list Done that leaves part of the thread behind', async () => {
  const notes = [];
  const deps = { advance() {}, remove() {}, restore() {}, decrementUnread() {}, incrementUnread() {}, notify: note => notes.push(note.title), t: key => key, gtdDone: async () => ({ ok: true, threadRemains: true, archiveFailed: true }) };
  const before = getGtdMetadataRefreshGeneration();
  await doneInboxGtdMessage({ id: 'message', is_read: true }, deps);
  assert.equal(getGtdMetadataRefreshGeneration(), before + 1);
  assert.deepEqual(notes, ['gtd.doneArchiveFailed', 'gtd.doneThreadRemains']);
});
