import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { createEmojiPicker } = await import('./emojiPicker.js');

// Minimal stand-in for emoji-mart's Picker: it mirrors the constructor contract
// (clear the ref container, append itself) and records update() calls.
function makeFakePicker() {
  const instances = [];
  class FakePicker {
    constructor(props) {
      this.props = props;
      this.updates = [];
      this.removed = false;
      this.el = document.createElement('em-emoji-picker');
      const container = props.ref.current;
      container.innerHTML = '';
      container.appendChild(this.el);
      instances.push(this);
    }
    update(props) { this.updates.push(props); }
    remove() { this.removed = true; this.el.remove(); }
  }
  return { FakePicker, instances };
}

test('emoji picker mounts once, pushes prop changes through update(), and cleans up', async () => {
  const { FakePicker, instances } = makeFakePicker();
  const EmojiPicker = createEmojiPicker(FakePicker);
  const container = document.getElementById('root');
  const root = createRoot(container);
  const onSelectA = () => {};
  const onSelectB = () => {};

  await React.act(async () => {
    root.render(React.createElement(EmojiPicker, { theme: 'auto', onEmojiSelect: onSelectA }));
  });
  assert.equal(instances.length, 1);
  assert.equal(instances[0].props.theme, 'auto');
  assert.equal(instances[0].props.onEmojiSelect, onSelectA);
  assert.equal(instances[0].updates.length, 0, 'the initial render must not re-apply the constructor props');
  assert.equal(container.querySelectorAll('em-emoji-picker').length, 1);

  await React.act(async () => {
    root.render(React.createElement(EmojiPicker, { theme: 'dark', onEmojiSelect: onSelectB }));
  });
  assert.equal(instances.length, 1, 'a re-render must not construct a second picker');
  assert.equal(instances[0].updates.length, 1);
  assert.equal(instances[0].updates[0].theme, 'dark');
  assert.equal(instances[0].updates[0].onEmojiSelect, onSelectB);

  await React.act(async () => root.unmount());
  assert.equal(instances[0].removed, true);
});

test('emoji picker leaves a single picker in the DOM under StrictMode double effects', async () => {
  const { FakePicker, instances } = makeFakePicker();
  const EmojiPicker = createEmojiPicker(FakePicker);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await React.act(async () => {
      root.render(React.createElement(React.StrictMode, null, React.createElement(EmojiPicker, { theme: 'auto' })));
    });
    assert.ok(instances.length >= 1);
    assert.equal(container.querySelectorAll('em-emoji-picker').length, 1);
    const live = instances.filter((p) => !p.removed);
    assert.equal(live.length, 1);
  } finally {
    await React.act(async () => root.unmount());
    dom.window.close();
  }
});
