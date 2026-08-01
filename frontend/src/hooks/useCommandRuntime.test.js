import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

describe('useCommandRuntime composition boundary', () => {
  it('owns the one registry/controller composition and exposes the fixed runtime shape', () => {
    const source = fs.readFileSync(new URL('./useCommandRuntime.js', import.meta.url), 'utf8');
    assert.match(source, /createCommandRegistry\(commandDefinitions\)/);
    assert.match(source, /createCommandController\(\{/);
    assert.match(source, /createAppCommandExecutors\(/);
    assert.match(source, /return useMemo\(\(\) => \(\{[\s\S]*registry[\s\S]*controller[\s\S]*getContext[\s\S]*continuation[\s\S]*clearContinuation/);
  });

  it('keeps controller composition out of MailApp and React out of engine modules', () => {
    const mailApp = fs.readFileSync(new URL('../components/MailApp.jsx', import.meta.url), 'utf8');
    const registry = fs.readFileSync(new URL('../commands/registry.js', import.meta.url), 'utf8');
    const controller = fs.readFileSync(new URL('../commands/controller.js', import.meta.url), 'utf8');
    assert.doesNotMatch(mailApp, /createCommandController/);
    assert.doesNotMatch(registry + controller, /from ['"]react['"]/);
  });

  it('installs shared mail executors and pending-removal guards in the one runtime', () => {
    const source = fs.readFileSync(new URL('./useCommandRuntime.js', import.meta.url), 'utf8');
    assert.match(source, /createMailActionExecutors/);
    assert.match(source, /setPendingDelete/);
    assert.match(source, /setCompletedDelete/);
    assert.match(source, /clearDeleteGuard/);
    assert.match(source, /\.\.\.createAppCommandExecutors/);
    assert.match(source, /\.\.\.createMailActionExecutors/);
  });

  it('owns migrated mail shortcut-bus compatibility until shortcut parity lands', () => {
    const source = fs.readFileSync(new URL('./useCommandRuntime.js', import.meta.url), 'utf8');
    for (const action of [
      'archive', 'delete', 'toggleRead', 'toggleStar', 'reply', 'replyAll', 'forward',
      'gtdTodo', 'gtdWatch', 'gtdDelegated',
    ]) assert.ok(source.includes(`shortcutBus.on('${action}'`), `missing ${action}`);
    assert.match(source, /source: 'shortcut'/);
  });

});
