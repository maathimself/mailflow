const assert = require('node:assert/strict');
const test = require('node:test');
const { writeClipboardText } = require('./clipboardText.cjs');

function silentLogger() {
  const errors = [];
  return { errors, error: (...args) => errors.push(args) };
}

test('awaits the asynchronous Electron 44 clipboard write', async () => {
  const written = [];
  const clipboard = {
    writeText: (text) => new Promise((resolve) => setTimeout(() => { written.push(text); resolve(); }, 5)),
  };
  const logger = silentLogger();

  const ok = await writeClipboardText(clipboard, 'sudo apt install ./MailExpert.deb', logger);

  assert.equal(ok, true);
  assert.deepEqual(written, ['sudo apt install ./MailExpert.deb'], 'the write must finish before the helper resolves');
  assert.deepEqual(logger.errors, []);
});

test('reports a rejected clipboard write without throwing', async () => {
  const clipboard = { writeText: () => Promise.reject(new Error('clipboard unavailable')) };
  const logger = silentLogger();

  const ok = await writeClipboardText(clipboard, 'text', logger);

  assert.equal(ok, false);
  assert.equal(logger.errors.length, 1);
});

test('reports a synchronously throwing clipboard write without throwing', async () => {
  const clipboard = { writeText: () => { throw new Error('boom'); } };
  const logger = silentLogger();

  assert.equal(await writeClipboardText(clipboard, 'text', logger), false);
  assert.equal(logger.errors.length, 1);
});

test('coerces non-string values to text', async () => {
  const written = [];
  const clipboard = { writeText: async (text) => { written.push(text); } };

  assert.equal(await writeClipboardText(clipboard, 42, silentLogger()), true);
  assert.deepEqual(written, ['42']);
});
