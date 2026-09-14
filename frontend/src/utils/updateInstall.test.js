import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { copyInstallCommandAndQuitOrWarn } from './updateInstall.js';

function setup(result) {
  const calls = [];
  const notifications = [];
  const updates = {
    copyInstallCommandAndQuit: async (options) => { calls.push(options); return result; },
  };
  return { calls, notifications, updates, addNotification: (n) => notifications.push(n) };
}

describe('copyInstallCommandAndQuitOrWarn', () => {
  it('passes the command and file path and stays silent when copied', async () => {
    const s = setup({ copied: true });
    await copyInstallCommandAndQuitOrWarn(s.updates, { installCommand: 'sudo apt install "x.deb"', filePath: '/tmp/x.deb' }, s.addNotification);
    assert.deepEqual(s.calls, [{ installCommand: 'sudo apt install "x.deb"', filePath: '/tmp/x.deb' }]);
    assert.deepEqual(s.notifications, []);
  });

  it('warns when the clipboard write failed', async () => {
    const s = setup({ copied: false, reason: 'clipboard-failed' });
    await copyInstallCommandAndQuitOrWarn(s.updates, { installCommand: 'cmd', filePath: '' }, s.addNotification);
    assert.equal(s.notifications.length, 1);
    assert.equal(s.notifications[0].type, 'error');
    assert.equal(s.notifications[0].title, 'Copy failed');
  });

  it('warns when the native bridge is unavailable', async () => {
    const notifications = [];
    await copyInstallCommandAndQuitOrWarn(undefined, { installCommand: 'cmd' }, (n) => notifications.push(n));
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].title, 'Copy failed');
  });
});

describe('ElectronNotificationBridge manual update actions', () => {
  it('routes every "Copy & Quit" action through the warning helper', () => {
    const source = readFileSync(new URL('../components/ElectronNotificationBridge.jsx', import.meta.url), 'utf8');
    // A direct bridge call would silently ignore { copied: false }.
    assert.doesNotMatch(source, /copyInstallCommandAndQuit\?\.\(/);
    const copyActions = source.match(/actionLabel: (?:manualInstall \? )?'Copy & Quit'/g) || [];
    const helperCalls = source.match(/copyInstallCommandAndQuitOrWarn\(/g) || [];
    assert.equal(copyActions.length, 2);
    assert.equal(helperCalls.length, copyActions.length);
  });
});
