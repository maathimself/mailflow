// Run with: node --test src/utils/sidebar.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { activateOnKey, collapsedTooltip } from './sidebar.js';

describe('collapsedTooltip', () => {
  it('surfaces the label as a tooltip while the rail is collapsed', () => {
    assert.equal(collapsedTooltip('jim@jimbob.com', true), 'jim@jimbob.com');
    assert.equal(collapsedTooltip('All Inboxes', true), 'All Inboxes');
  });

  it('gives no tooltip when expanded, where the label is already on screen', () => {
    assert.equal(collapsedTooltip('jim@jimbob.com', false), undefined);
  });

  it('gives no tooltip for an account with no address, rather than an empty one', () => {
    assert.equal(collapsedTooltip('', true), undefined);
    assert.equal(collapsedTooltip('   ', true), undefined);
    assert.equal(collapsedTooltip(undefined, true), undefined);
    assert.equal(collapsedTooltip(null, true), undefined);
  });
});

describe('activateOnKey', () => {
  const press = (key) => {
    const event = { key, prevented: false, preventDefault() { this.prevented = true; } };
    return event;
  };

  it('activates on Enter and on Space, as a real button would', () => {
    for (const key of ['Enter', ' ']) {
      let activated = 0;
      const event = press(key);
      activateOnKey(() => { activated += 1; })(event);
      assert.equal(activated, 1, `expected ${JSON.stringify(key)} to activate`);
    }
  });

  it('swallows the Space keypress so the rail does not scroll underneath', () => {
    const event = press(' ');
    activateOnKey(() => {})(event);
    assert.equal(event.prevented, true);
  });

  it('ignores every other key, leaving Tab and arrows to the browser', () => {
    for (const key of ['Tab', 'ArrowDown', 'a', 'Escape']) {
      let activated = 0;
      const event = press(key);
      activateOnKey(() => { activated += 1; })(event);
      assert.equal(activated, 0, `expected ${JSON.stringify(key)} to be ignored`);
      assert.equal(event.prevented, false, `expected ${JSON.stringify(key)} to pass through`);
    }
  });
});
