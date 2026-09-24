import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { shortcutActionText } from './defaultShortcuts.js';

const localeFiles = readdirSync(new URL('../locales/', import.meta.url)).filter(name => name.endsWith('.json'));
const actions = ['toggleLeftSidebar', 'openLabelPicker', 'replyAllFromSelection', 'markUnread', 'unsubscribe', 'loadRemoteImages'];

test('new shortcut help and settings text is localized in every supported language', () => {
  for (const name of localeFiles) {
    const locale = JSON.parse(readFileSync(new URL(`../locales/${name}`, import.meta.url), 'utf8'));
    for (const action of actions) {
      assert.ok(locale.shortcuts.actions[action]?.label, `${name}: ${action} label`);
      assert.ok(locale.shortcuts.actions[action]?.description, `${name}: ${action} description`);
    }
    assert.ok(locale.shortcuts.visibleMailbox?.label, `${name}: visible mailbox label`);
    assert.ok(locale.shortcuts.visibleMailbox?.description, `${name}: visible mailbox description`);
    assert.ok(locale.shortcuts.browserMailboxFallback, `${name}: browser fallback`);
  }
});

test('numbered mailbox labels use a translated template', () => {
  const calls = [];
  const t = (key, options) => { calls.push([key, options]); return key; };
  shortcutActionText(t, 'goVisibleMailbox2', 'label');
  assert.equal(calls[0][0], 'shortcuts.visibleMailbox.label');
  assert.equal(calls[0][1].number, 2);
});
