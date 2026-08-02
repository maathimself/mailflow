import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import i18next from 'i18next';
import { createCommandRegistry } from './registry.js';
import {
  composeSessionCommandDefinitions,
  createComposeSessionCommandExecutors,
} from './composeSessionCommands.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const context = ({ slots = [], draft = null, surface = 'list' } = {}) => ({
  surface,
  draft,
  composeSlots: slots,
  accountId: null,
  activeConversationId: null,
  selectedConversationIds: [],
  conversationsById: {},
  platform: 'linux',
  shortcutOverrides: {},
  translate: key => key,
});

describe('compose session commands', () => {
  it('defines one stable command for every compose action and slot', () => {
    assert.deepEqual(composeSessionCommandDefinitions.map(command => command.id), [
      'compose.new', 'compose.minimize', 'compose.close', 'compose.discard', 'compose.send',
      ...Array.from({ length: 9 }, (_, index) => `compose.activateSlot${index + 1}`),
    ]);
    assert.equal(new Set(composeSessionCommandDefinitions).size, 14);
    assert.ok(composeSessionCommandDefinitions.every(Object.isFrozen));
    for (const id of ['compose.minimize', 'compose.close', 'compose.discard', 'compose.send']) {
      assert.equal(
        composeSessionCommandDefinitions.find(command => command.id === id).targetMode,
        'draft',
      );
    }
    assert.deepEqual(
      composeSessionCommandDefinitions.find(command => command.id === 'compose.send').defaultKeys.primary,
      { mac: 'meta+enter', windows: 'ctrl+enter', linux: 'ctrl+enter', default: 'ctrl+enter' },
    );
  });

  it('offers create below capacity and omits it at nine occupied slots', () => {
    const registry = createCommandRegistry(composeSessionCommandDefinitions);
    const eight = Array.from({ length: 8 }, (_, index) => ({ id: `session-${index + 1}`, slot: index + 1 }));
    assert.ok(registry.list(context({ slots: eight })).some(result => result.command.id === 'compose.new'));
    const nine = [...eight, { id: 'session-9', slot: 9 }];
    assert.equal(registry.list(context({ slots: nine })).some(result => result.command.id === 'compose.new'), false);
  });

  it('offers activation only for occupied slots', () => {
    const registry = createCommandRegistry(composeSessionCommandDefinitions);
    const ids = registry.list(context({
      slots: [{ id: 'session-2', slot: 2 }, { id: 'session-7', slot: 7 }],
    })).map(result => result.command.id);
    assert.ok(ids.includes('compose.activateSlot2'));
    assert.ok(ids.includes('compose.activateSlot7'));
    assert.equal(ids.includes('compose.activateSlot1'), false);
    assert.equal(ids.includes('compose.activateSlot9'), false);
  });

  it('renders an occupied slot title through configured i18next interpolation', async () => {
    const translation = JSON.parse(readFileSync(
      new URL('../locales/en.json', import.meta.url), 'utf8',
    ));
    const instance = i18next.createInstance();
    await instance.init({
      resources: { en: { translation } },
      lng: 'en',
      fallbackLng: 'en',
      interpolation: { escapeValue: false },
    });
    const registry = createCommandRegistry(composeSessionCommandDefinitions);
    const commandContext = context({ slots: [{ id: 'session-7', slot: 7 }] });
    commandContext.translate = instance.t.bind(instance);
    const title = registry.list(commandContext)
      .find(result => result.command.id === 'compose.activateSlot7')?.title;
    assert.equal(title, 'Activate draft 7');
    assert.doesNotMatch(title, /[{}]|<slot>/);
  });

  it('withholds terminal-pending slot activation and restores it after completion', () => {
    const registry = createCommandRegistry(composeSessionCommandDefinitions);
    const ids = slots => registry.list(context({ slots })).map(result => result.command.id);
    assert.equal(ids([{ id: 'session-7', slot: 7, terminalPending: 'send' }])
      .includes('compose.activateSlot7'), false);
    assert.equal(ids([{ id: 'session-7', slot: 7, terminalPending: null }])
      .includes('compose.activateSlot7'), true);
  });

  it('uses the focused draft for lifecycle commands and freezes them while terminal work is pending', () => {
    const registry = createCommandRegistry(composeSessionCommandDefinitions);
    const cleanSlot = { id: 'session-4', slot: 4, terminalPending: null };
    const available = registry.list(context({
      slots: [cleanSlot], draft: { id: cleanSlot.id, slot: cleanSlot.slot }, surface: 'compose',
    })).map(result => result.command.id);
    for (const id of ['compose.minimize', 'compose.close', 'compose.discard', 'compose.send']) {
      assert.ok(available.includes(id), `missing ${id}`);
    }

    const frozen = registry.list(context({
      slots: [{ ...cleanSlot, terminalPending: 'send' }],
      draft: { id: cleanSlot.id, slot: cleanSlot.slot },
      surface: 'compose',
    })).map(result => result.command.id);
    for (const id of ['compose.minimize', 'compose.close', 'compose.discard', 'compose.send']) {
      assert.equal(frozen.includes(id), false, `${id} must freeze`);
    }
  });

  it('routes every executor exclusively through the workspace controller', async () => {
    const calls = [];
    const controller = {
      createSession: value => { calls.push(['create', value]); return { id: 'created' }; },
      minimizeSession: id => { calls.push(['minimize', id]); return { id }; },
      closeSession: id => { calls.push(['close', id]); return { id }; },
      discardSession: id => { calls.push(['discard', id]); return { id }; },
      sendSession: (id, options) => { calls.push(['send', id, options]); return { id }; },
      focusSession: id => { calls.push(['focus', id]); return { id }; },
    };
    const executors = createComposeSessionCommandExecutors({ getController: () => controller });
    const draftContext = context({
      slots: [{ id: 'session-3', slot: 3 }],
      draft: { id: 'session-3', slot: 3 },
      surface: 'compose',
    });
    assert.equal((await executors['compose.create']({ input: { accountId: 'synthetic-account' } })).status, 'success');
    assert.equal((await executors['compose.minimize']({ context: draftContext })).status, 'success');
    assert.equal((await executors['compose.close']({ context: draftContext })).status, 'success');
    assert.equal((await executors['compose.discard']({ context: draftContext })).status, 'success');
    assert.equal((await executors['compose.send']({ context: draftContext, input: { undoSeconds: 5 } })).status, 'success');
    assert.equal((await executors['compose.activateSlot']({
      context: draftContext,
      command: { params: { slot: 3 } },
    })).status, 'success');
    assert.deepEqual(calls, [
      ['create', { accountId: 'synthetic-account' }],
      ['minimize', 'session-3'],
      ['close', 'session-3'],
      ['discard', 'session-3'],
      ['send', 'session-3', { undoSeconds: 5 }],
      ['focus', 'session-3'],
    ]);
  });

  it('returns cancelled outcomes when a controller or requested session is unavailable', async () => {
    const withoutController = createComposeSessionCommandExecutors({ getController: () => null });
    assert.deepEqual(await withoutController['compose.create']({}), { status: 'cancelled' });

    const executors = createComposeSessionCommandExecutors({
      getController: () => ({ focusSession() { throw new Error('must not execute'); } }),
    });
    assert.deepEqual(await executors['compose.activateSlot']({
      context: context({ slots: [] }), command: { params: { slot: 8 } },
    }), { status: 'cancelled' });
    assert.deepEqual(await executors['compose.activateSlot']({
      context: context({
        slots: [{ id: 'session-8', slot: 8, terminalPending: 'discard' }],
      }),
      command: { params: { slot: 8 } },
    }), { status: 'cancelled' });
  });

  it('routes compose.new through the readiness-aware store action and awaits its outcome', async () => {
    const ready = deferred();
    const calls = [];
    const executors = createComposeSessionCommandExecutors({
      getController: () => null,
      openCompose: changes => { calls.push(changes); return ready.promise; },
    });
    const pending = executors['compose.create']({
      context: context(), input: { subject: 'Queued command' },
    });
    assert.deepEqual(calls, [{ subject: 'Queued command' }]);
    ready.resolve('created-after-ready');
    assert.deepEqual(await pending, { status: 'success', value: 'created-after-ready' });

    const failure = new Error('synthetic command create failure');
    const rejecting = createComposeSessionCommandExecutors({
      getController: () => null,
      openCompose: async () => { throw failure; },
    });
    await assert.rejects(rejecting['compose.create']({ context: context() }), error => error === failure);
  });
});
