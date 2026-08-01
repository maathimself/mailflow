import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCommandContext } from './contracts.js';
import { createCommandRegistry } from './registry.js';
import { createCommandController } from './controller.js';

const definition = (overrides = {}) => ({
  id: 'mail.move', titleKey: 'move', aliasKeys: [], icon: 'move', group: 'mail',
  defaultKeys: { primary: 'v', secondary: [] }, rank: { base: 1 },
  isAvailable: () => true, targetMode: 'bulk_safe', executorId: 'mail.move', ...overrides,
});
const makeContext = (ids = ['acct:<a>', 'acct:<b>']) => createCommandContext({
  surface: 'list', activeConversationId: 'acct:<a>', selectedConversationIds: ids,
  conversations: ids.map((id, index) => ({ id: `row-${index}`, message_id: id.slice('acct:'.length), account_id: 'acct' })),
  accountId: 'acct', folder: 'INBOX', draft: null, gtdAvailable: false,
  cardDavConnected: false, modal: null, editing: false, platform: 'mac',
  shortcutOverrides: {}, translate: key => key,
});

describe('createCommandController', () => {
  it('rejects unknown, unavailable, and missing executors as failed outcomes', async () => {
    const registry = createCommandRegistry([definition({ isAvailable: () => false })]);
    const controller = createCommandController({ registry, getContext: () => makeContext(), executors: {} });
    assert.match((await controller.execute('missing.command')).error.message, /Unknown command/);
    assert.match((await controller.execute('mail.move')).error.message, /not available/);

    const available = createCommandRegistry([definition()]);
    const noExecutor = createCommandController({ registry: available, getContext: () => makeContext(), executors: {} });
    assert.match((await noExecutor.execute('mail.move')).error.message, /Missing executor/);
  });

  it('freezes targets into a continuation and reuses them on resume', async () => {
    let context = makeContext();
    const calls = [];
    const continuations = [];
    const registry = createCommandRegistry([definition()]);
    const controller = createCommandController({
      registry,
      getContext: () => context,
      executors: {
        'mail.move': args => {
          calls.push(args);
          return args.input
            ? { status: 'success', value: { folder: args.input.folder } }
            : { status: 'needs_input', continuation: { kind: 'move', props: { titleKey: 'move.title' } } };
        },
      },
      onContinuation: value => continuations.push(value),
    });

    const first = await controller.execute('mail.move', { source: 'palette' });
    assert.deepEqual(first.continuation, {
      commandId: 'mail.move', kind: 'move', targetIds: ['acct:<a>', 'acct:<b>'], props: { titleKey: 'move.title' },
    });
    assert.deepEqual(continuations, [first.continuation]);

    context = makeContext(['acct:<a>']);
    const resumed = await controller.execute('mail.move', {
      source: 'palette', input: { folder: 'Archive' }, frozenTargetIds: first.continuation.targetIds,
    });
    assert.equal(resumed.status, 'partial');
    assert.deepEqual(resumed.targetIds, ['acct:<a>']);
    assert.deepEqual(resumed.missingTargetIds, ['acct:<b>']);
    assert.deepEqual(calls[1].targetIds, ['acct:<a>']);
  });

  it('resumes frozen targets after the current selection becomes unavailable', async () => {
    let context = makeContext(['acct:<a>']);
    const registry = createCommandRegistry([definition({
      isAvailable: current => current.gtdAvailable,
    })]);
    context = Object.freeze({ ...context, gtdAvailable: true });
    const controller = createCommandController({
      registry,
      getContext: () => context,
      executors: { 'mail.move': () => ({ status: 'success' }) },
    });
    const frozenTargetIds = ['acct:<a>'];
    context = Object.freeze({ ...context, gtdAvailable: false });
    const outcome = await controller.execute('mail.move', {
      source: 'continuation', input: { contactId: 'contact-1' }, frozenTargetIds,
    });
    assert.equal(outcome.status, 'success');
    assert.deepEqual(outcome.targetIds, frozenTargetIds);
  });

  it('deduplicates only concurrent execution of the same command and target set', async () => {
    let release;
    let callCount = 0;
    const gate = new Promise(resolve => { release = resolve; });
    const registry = createCommandRegistry([definition()]);
    const controller = createCommandController({
      registry, getContext: () => makeContext(),
      executors: { 'mail.move': async () => { callCount += 1; await gate; return { status: 'success' }; } },
    });
    const one = controller.execute('mail.move');
    const two = controller.execute('mail.move');
    assert.strictEqual(one, two);
    release();
    await one;
    await controller.execute('mail.move');
    assert.equal(callCount, 2);
  });

  it('rejects a frozen multi-selection for single-conversation commands', async () => {
    let callCount = 0;
    const registry = createCommandRegistry([definition({
      id: 'mail.reply',
      targetMode: 'single_conversation',
      executorId: 'mail.reply',
    })]);
    const controller = createCommandController({
      registry,
      getContext: () => makeContext(),
      executors: {
        'mail.reply': () => {
          callCount += 1;
          return { status: 'success' };
        },
      },
    });

    const outcome = await controller.execute('mail.reply', {
      source: 'context-menu',
      frozenTargetIds: ['acct:<a>', 'acct:<b>'],
    });

    assert.equal(outcome.status, 'failed');
    assert.match(outcome.error.message, /exactly one conversation/);
    assert.equal(callCount, 0);
  });

  it('normalizes success, cancelled, partial, thrown failures, and callback delivery', async () => {
    const terminal = [];
    const outcomes = ['success', 'cancelled', 'partial'];
    for (const status of outcomes) {
      const registry = createCommandRegistry([definition()]);
      const controller = createCommandController({
        registry, getContext: () => makeContext(['acct:<a>']),
        executors: { 'mail.move': () => status === 'partial'
          ? { status, succeededIds: [], failed: [{ targetId: 'acct:<a>', error: new Error('nope') }] }
          : { status } },
        onOutcome: outcome => terminal.push(outcome.status),
      });
      assert.equal((await controller.execute('mail.move')).status, status);
    }
    const registry = createCommandRegistry([definition()]);
    const failed = createCommandController({
      registry, getContext: () => makeContext(['acct:<a>']),
      executors: { 'mail.move': () => { throw new Error('boom'); } },
      onOutcome: outcome => terminal.push(outcome.status),
    });
    assert.equal((await failed.execute('mail.move')).status, 'failed');
    assert.deepEqual(terminal, ['success', 'cancelled', 'partial', 'failed']);
  });
});
