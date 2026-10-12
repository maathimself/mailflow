const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { createNotificationRetainer, MAX_RETAINED } = require('./notificationRetainer.cjs');

// #587: a new-mail notification has to stay referenced while it can still be clicked.
test('keeps a notification until it closes', () => {
  const retainer = createNotificationRetainer();
  const notification = new EventEmitter();
  retainer.retain(notification);
  assert.equal(retainer.has(notification), true);
  notification.emit('close');
  assert.equal(retainer.has(notification), false);
});

test('lets go of one that failed to show', () => {
  const retainer = createNotificationRetainer();
  const notification = new EventEmitter();
  retainer.retain(notification);
  notification.emit('failed', new Error('no notification server'));
  assert.equal(retainer.size, 0);
});

test('keeps only the newest when closes never come', () => {
  const retainer = createNotificationRetainer();
  const all = Array.from({ length: MAX_RETAINED + 5 }, () => new EventEmitter());
  all.forEach((notification) => retainer.retain(notification));
  assert.equal(retainer.size, MAX_RETAINED);
  assert.equal(retainer.has(all[0]), false, 'the oldest go first');
  assert.equal(retainer.has(all.at(-1)), true);
});
