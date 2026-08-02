import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createPaletteState, paletteKeyIntent, reducePaletteState } from './paletteState.js';

describe('palette state', () => {
  it('maps every approved local navigation key', () => {
    assert.equal(paletteKeyIntent({ key: 'ArrowDown', ctrlKey: false }), 'next');
    assert.equal(paletteKeyIntent({ key: 'n', ctrlKey: true }), 'next');
    assert.equal(paletteKeyIntent({ key: 'j', ctrlKey: true }), 'next');
    assert.equal(paletteKeyIntent({ key: 'ArrowUp', ctrlKey: false }), 'previous');
    assert.equal(paletteKeyIntent({ key: 'p', ctrlKey: true }), 'previous');
    assert.equal(paletteKeyIntent({ key: 'k', ctrlKey: true }), 'previous');
    assert.equal(paletteKeyIntent({ key: 'Enter', ctrlKey: false }), 'execute');
    assert.equal(paletteKeyIntent({ key: 'Escape', ctrlKey: false }), 'back');
  });

  it('ignores navigation and execution keys while an IME is composing', () => {
    assert.equal(paletteKeyIntent({ key: 'Enter', isComposing: true }), null);
    assert.equal(paletteKeyIntent({ key: 'ArrowDown', nativeEvent: { isComposing: true } }), null);
    assert.equal(paletteKeyIntent({ key: 'Enter', keyCode: 229 }), null);
  });

  it('resets highlight on query/results and clamps movement', () => {
    let state = reducePaletteState(createPaletteState(), { type: 'results', count: 2 });
    state = reducePaletteState(state, { type: 'move', delta: 1 });
    state = reducePaletteState(state, { type: 'move', delta: 1 });
    assert.equal(state.activeIndex, 1);
    state = reducePaletteState(state, { type: 'query', query: 'arch' });
    assert.equal(state.activeIndex, 0);
  });

  it('opens with the current result count so keyboard movement works immediately', () => {
    let state = reducePaletteState(createPaletteState(), { type: 'results', count: 38 });
    state = reducePaletteState(state, { type: 'open' });
    state = reducePaletteState(state, { type: 'move', delta: 1 });
    assert.equal(state.resultCount, 38);
    assert.equal(state.activeIndex, 1);
  });

  it('backs out one continuation without latching a close request across reopen', () => {
    let state = reducePaletteState(createPaletteState(), { type: 'continuation', value: { kind: 'move' } });
    state = reducePaletteState(state, { type: 'back' });
    assert.equal(state.continuation, null);
    state = reducePaletteState(state, { type: 'back' });
    assert.equal('closeRequested' in state, false);
    state = reducePaletteState(state, { type: 'open' });
    assert.equal('closeRequested' in state, false);
  });
});
