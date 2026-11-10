import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../plugins/registry.js', () => ({ pluginRegistry: { runHook: vi.fn() } }));
import { pluginRegistry } from '../plugins/registry.js';
import { notifyMessageRowsDeleted } from './messageRowsDeleted.js';

afterEach(() => vi.restoreAllMocks());

describe('messageRowsDeleted dispatch', () => {
  it('groups actual returned rows by account and folder, deduplicating keys within each group', () => {
    pluginRegistry.runHook.mockReset().mockResolvedValue([]);
    notifyMessageRowsDeleted(null, [
      { account_id: 'a', folder: 'Todo', thread_key: 'one' },
      { account_id: 'a', folder: 'Todo', thread_key: 'one' },
      { account_id: 'a', folder: 'Done', thread_key: 'one' },
      { account_id: 'b', folder: 'Todo', thread_key: 'two' },
      { account_id: 'a', folder: 'Todo', thread_key: null },
    ], undefined, 'fixture-user');
    expect(pluginRegistry.runHook.mock.calls).toEqual([
      ['messageRowsDeleted', { account: { id: 'a', user_id: 'fixture-user' }, folder: 'Todo', threadKeys: ['one'] }],
      ['messageRowsDeleted', { account: { id: 'a', user_id: 'fixture-user' }, folder: 'Done', threadKeys: ['one'] }],
      ['messageRowsDeleted', { account: { id: 'b', user_id: 'fixture-user' }, folder: 'Todo', threadKeys: ['two'] }],
    ]);
  });

  it('does not wait for a hanging plugin or dispatch an empty deletion', () => {
    pluginRegistry.runHook.mockReset().mockReturnValue(new Promise(() => {}));
    const account = { id: 'a', user_id: 'u' };
    expect(notifyMessageRowsDeleted(account, [{ thread_key: 'one' }], 'Todo')).toBeUndefined();
    notifyMessageRowsDeleted(account, [], 'Todo');
    expect(pluginRegistry.runHook).toHaveBeenCalledOnce();
    expect(pluginRegistry.runHook).toHaveBeenCalledWith('messageRowsDeleted', { account, folder: 'Todo', threadKeys: ['one'] });
  });

  it.each([[new Error('handler failed'), 'handler failed'], [undefined, 'Unknown error'], [null, 'Unknown error'], ['handler failed', 'handler failed']])('logs a handler rejection %j without creating an unhandled rejection', async (error, reason) => {
    pluginRegistry.runHook.mockReset().mockResolvedValue([{ pluginId: 'broken', error }]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    notifyMessageRowsDeleted({ id: 'a' }, [{ thread_key: 'one' }], 'Todo');
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith('Message deletion hook failed (broken):', reason));
  });
});
