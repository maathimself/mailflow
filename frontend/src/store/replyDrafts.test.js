import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
registerHooks({ load(url, context, nextLoad) {
  return url.endsWith('.json') ? { format: 'module', source: `export default ${readFileSync(new URL(url), 'utf8')}`, shortCircuit: true } : nextLoad(url, context);
} });
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const { useStore } = await import('./index.js');

const shown = id => useStore.getState().replyDrafts[id]?.exists === true;
beforeEach(() => useStore.setState({ replyDrafts: {}, replyDraftRevision: 0 }));

test('a draft change keeps the marker until the new lookup answers (#810)', () => {
  const s = useStore.getState();
  s.setReplyDraftStatus('m1', { exists: true, accountId: 'a' }, 'live', 0);
  s.setReplyDraftStatus('m2', { exists: false }, 'cached', 0);
  s.invalidateReplyDrafts();
  const { replyDraftRevision: revision } = useStore.getState();
  assert.equal(revision, 1);
  assert.equal(shown('m1'), true, 'still shown while its draft is saved again');
  assert.equal(useStore.getState().replyDrafts.m2, undefined, 'nothing kept that showed nothing');
  // A cached answer replaces the stale entry, even one that was 'live' before.
  s.setReplyDraftStatus('m1', { exists: true, accountId: 'a' }, 'cached', revision);
  assert.equal(useStore.getState().replyDrafts.m1.source, 'cached');
});

test('the new lookup hides a marker whose draft is gone', () => {
  const s = useStore.getState();
  s.setReplyDraftStatus('m1', { exists: true }, 'live', 0);
  s.invalidateReplyDrafts();
  s.setReplyDraftStatus('m1', { exists: false }, 'cached', 1);
  assert.equal(shown('m1'), false);
});

test('a status the lookup did not answer for is dropped after it, and only for that revision', () => {
  const s = useStore.getState();
  s.setReplyDraftStatus('m1', { exists: true }, 'live', 0);
  s.setReplyDraftStatus('m2', { exists: true }, 'live', 0);
  s.invalidateReplyDrafts();
  s.dropStaleReplyDrafts(['m1', 'm2'], 0);
  assert.equal(shown('m1'), true, 'an older lookup finishing late drops nothing');
  s.setReplyDraftStatus('m2', { exists: true }, 'cached', 1);
  s.dropStaleReplyDrafts(['m1', 'm2'], 1);
  assert.equal(shown('m1'), false, 'no answer for m1: dropped');
  assert.equal(shown('m2'), true, 'answered: kept');
});
