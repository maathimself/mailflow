import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('.json')) return { format: 'module', source: `export default ${readFileSync(new URL(url), 'utf8')}`, shortCircuit: true };
  return nextLoad(url, context);
}});
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const { api } = await import('../utils/api.js');
const { useStore } = await import('./index.js');
const originalGet = api.getPreferences;
const originalSave = api.savePreferences;
describe('server-backed sender grouping preferences', () => {
  beforeEach(() => useStore.setState({ user: { id: 'user-1' }, groupedSenders: [], senderGroupingSaving: false, threadMessages: {}, messages: [], searchResults: [] }));
  afterEach(() => { api.getPreferences = originalGet; api.savePreferences = originalSave; });
  it('saves normalized senders, then removes them using the same control', async () => {
    const saves = [];
    api.savePreferences = async prefs => { saves.push(prefs); };
    await useStore.getState().toggleSenderGrouping(' Alerts@Example.com ');
    assert.deepEqual(saves[0], { groupedSenders: ['alerts@example.com'] });
    assert.deepEqual(useStore.getState().groupedSenders, ['alerts@example.com']);
    await useStore.getState().toggleSenderGrouping('alerts@example.com');
    assert.deepEqual(saves[1], { groupedSenders: [] });
  });
  it('hydrates on another device and does not apply failed saves', async () => {
    api.getPreferences = async () => ({ groupedSenders: ['alerts@example.com'], aiActions: [] });
    await useStore.getState().loadPreferences();
    assert.deepEqual(useStore.getState().groupedSenders, ['alerts@example.com']);
    api.savePreferences = async () => { throw new Error('offline'); };
    await assert.rejects(useStore.getState().toggleSenderGrouping('alerts@example.com'), /offline/);
    assert.deepEqual(useStore.getState().groupedSenders, ['alerts@example.com']);
    assert.equal(useStore.getState().senderGroupingSaving, false);
  });
  it('discards a pending save after switching users', async () => {
    let complete;
    api.savePreferences = () => new Promise(resolve => { complete = resolve; });
    const saving = useStore.getState().toggleSenderGrouping('alerts@example.com');
    useStore.getState().setUser({ id: 'user-2' });
    complete(); await saving;
    assert.deepEqual(useStore.getState().groupedSenders, []);
  });
  it('updates a sender badge when a cached member is marked read', () => {
    const member = { id: 'member', from_email: 'alerts@example.com', is_read: false };
    const key = 'sender:{}:alerts@example.com';
    useStore.setState({ messages: [{ id: 'head', sender_group: 'alerts@example.com', sender_unread_count: 2 }], threadMessages: { [key]: [member] } });
    useStore.getState().updateMessage('member', { is_read: true });
    assert.equal(useStore.getState().messages[0].sender_unread_count, 1);
    useStore.getState().updateMessage('member', { is_read: false });
    assert.equal(useStore.getState().messages[0].sender_unread_count, 2);
  });
  it('removes and restores a member without discarding its whole sender group', () => {
    const member = { id: 'latest', from_email: 'alerts@example.com', date: '2026-10-01T10:00:00Z' };
    const key = 'sender:{}:alerts@example.com';
    useStore.setState({ messages: [{ ...member, sender_group: 'alerts@example.com' }], threadMessages: { [key]: [member] } });
    useStore.getState().removeMessage(member.id);
    assert.equal(useStore.getState().messages.length, 1);
    assert.equal(useStore.getState().threadMessages[key].length, 0);
    useStore.getState().restoreMessages([member]);
    assert.equal(useStore.getState().messages.length, 1);
    assert.equal(useStore.getState().threadMessages[key].length, 1);
  });
});
