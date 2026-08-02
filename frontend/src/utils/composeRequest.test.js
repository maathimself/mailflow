import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handleComposeRequest } from './composeRequest.js';

describe('compose request event boundaries', () => {
  it('returns successful controller results unchanged', async () => {
    const notifications = [];
    const result = await handleComposeRequest(async () => 'created', {
      addNotification: value => notifications.push(value),
      t: key => key,
      logError: () => { throw new Error('must not log success'); },
    });
    assert.equal(result, 'created');
    assert.deepEqual(notifications, []);
  });

  it('handles rejection with a bounded localized error and no escaped rejection', async () => {
    const privateDetail = 'PRIVATE_DETAIL_SENTINEL_8472';
    const failure = Object.assign(new Error(`server dump for ${privateDetail}`), {
      code: `technical_${privateDetail}`,
      details: { privateDetail },
    });
    const notifications = [];
    const logged = [];
    const result = await handleComposeRequest(async () => { throw failure; }, {
      addNotification: value => notifications.push(value),
      t: key => `localized:${key}`,
      logError: (...values) => logged.push(values),
    });
    assert.equal(result, null);
    assert.deepEqual(notifications, [{
      type: 'error', title: 'localized:compose.requestFailed',
    }]);
    assert.deepEqual(logged, [[
      'Compose request failed',
      { code: 'compose_request_failed', context: 'event_boundary' },
    ]]);
    const exposed = JSON.stringify({ notifications, logged });
    assert.doesNotMatch(exposed, /PRIVATE_DETAIL_SENTINEL|server dump|technical_/);
    assert.ok(exposed.length < 300);
  });

  it('is used by every native, mailto, and button compose event boundary', () => {
    for (const relative of [
      '../components/MailApp.jsx',
      '../components/ElectronNotificationBridge.jsx',
      '../components/MessageList.jsx',
      '../components/Sidebar.jsx',
      '../hooks/useGtdTriage.js',
      './outboxNotifications.js',
    ]) {
      const source = readFileSync(new URL(relative, import.meta.url), 'utf8');
      assert.match(source, /handleComposeRequest/, relative);
    }
  });
});
