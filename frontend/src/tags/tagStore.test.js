import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../utils/api.js';
import { useTagStore, requestTags, invalidateTags, clearTagCache, bumpTagDefinitions } from './tagStore.js';

const wait = (ms = 80) => new Promise((r) => setTimeout(r, ms));
const tag = (name) => ({ tagId: `t-${name}`, name, color: '#000000' });

describe('tag cache', () => {
  let calls;
  beforeEach(() => {
    clearTagCache();
    calls = [];
    api.tagsForMessages = async (ids) => { calls.push([...ids]); return { a: [tag('urgent')] }; };
  });

  it('batches lookups made in the same tick into one request and caches empty results', async () => {
    requestTags('a'); requestTags('b'); requestTags('a');
    await wait();
    assert.deepEqual(calls, [['a', 'b']]);
    const { byMessage } = useTagStore.getState();
    assert.equal(byMessage.a[0].name, 'urgent');
    assert.deepEqual(byMessage.b, []);
    requestTags('a');
    await wait();
    assert.equal(calls.length, 1, 'cached ids are not requested again');
  });

  it('refetches when invalidated', async () => {
    requestTags('a');
    await wait();
    invalidateTags(['a']);
    await wait();
    assert.equal(calls.length, 2);
  });

  it('keeps ids unknown when the request fails, so the next render retries', async () => {
    api.tagsForMessages = async () => { throw new Error('offline'); };
    requestTags('x');
    await wait();
    assert.equal(useTagStore.getState().byMessage.x, undefined);
    api.tagsForMessages = async (ids) => { calls.push([...ids]); return {}; };
    requestTags('x');
    await wait();
    assert.deepEqual(useTagStore.getState().byMessage.x, []);
  });
});

describe('tag definitions revision', () => {
  it('increases on every announced change, and clearing the message cache keeps it', () => {
    const before = useTagStore.getState().definitionsRevision;
    bumpTagDefinitions();
    bumpTagDefinitions();
    assert.equal(useTagStore.getState().definitionsRevision, before + 2);
    clearTagCache();
    assert.equal(useTagStore.getState().definitionsRevision, before + 2);
  });
});
