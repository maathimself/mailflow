// Electron stops delivering a Notification's `click` and `action` events once V8 has collected the
// object. Nothing referenced a new-mail notification after show(), so clicking one a few seconds
// later often did nothing (#587). Keep each one until it closes or fails to show. Some notification
// servers never report a close for one left in the notification center, so only the newest are
// kept: a click on a very old notification can still be lost, as every click could before.
const MAX_RETAINED = 20;

function createNotificationRetainer(max = MAX_RETAINED) {
  const active = new Set();
  return {
    retain(notification) {
      active.add(notification);
      const release = () => { active.delete(notification); };
      notification.on('close', release);
      notification.on('failed', release);
      while (active.size > max) active.delete(active.values().next().value);
    },
    get size() { return active.size; },
    has(notification) { return active.has(notification); },
  };
}

module.exports = { createNotificationRetainer, MAX_RETAINED };
