// Run with: node --test src/utils/defaultShortcuts.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildKeyMap, buildModKeyMap } from './defaultShortcuts.js';

describe('buildKeyMap', () => {
  it('does not warn when no overrides are given (defaults have no collisions)', (t) => {
    const warn = t.mock.method(console, 'warn', () => {});
    buildKeyMap();
    assert.equal(warn.mock.callCount(), 0);
  });

  it('warns and keeps last-writer-wins when an override collides with a default key', (t) => {
    const warn = t.mock.method(console, 'warn', () => {});
    // 'archive' defaults to 'e'; override 'delete' (default '#') to the same key.
    const map = buildKeyMap({ delete: 'e' });
    assert.equal(warn.mock.callCount(), 1);
    const [message] = warn.mock.calls[0].arguments;
    assert.match(message, /"e"/);
    assert.match(message, /"archive"/);
    assert.match(message, /"delete"/);
    assert.equal(map.e, 'delete', 'later action (delete) should win');
  });
});

describe('buildModKeyMap', () => {
  it('does not warn when no overrides are given (defaults have no collisions)', (t) => {
    const warn = t.mock.method(console, 'warn', () => {});
    buildModKeyMap();
    assert.equal(warn.mock.callCount(), 0);
  });

  it('warns and keeps last-writer-wins when an override collides on a modifier+key', (t) => {
    const warn = t.mock.method(console, 'warn', () => {});
    // 'printMessage' defaults to 'ctrl+p'; override 'toggleStar' (default 's') to the same combo.
    const map = buildModKeyMap({ toggleStar: 'ctrl+p' });
    assert.equal(warn.mock.callCount(), 1);
    const [message] = warn.mock.calls[0].arguments;
    assert.match(message, /"p"/);
    assert.match(message, /"toggleStar"/);
    assert.match(message, /"printMessage"/);
    assert.equal(map.p, 'printMessage', 'later action (printMessage) should win');
  });
});
