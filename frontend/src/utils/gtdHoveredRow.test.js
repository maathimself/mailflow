import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  registerHoveredGtdRow,
  clearHoveredGtdRow,
  dispatchHoveredGtdShortcut,
} from './gtdHoveredRow.js';

describe('hovered GTD row shortcuts', () => {
  it('routes Todo, Watch, and archive shortcuts to the hovered row actions', () => {
    const calls = [];
    const token = registerHoveredGtdRow({
      classify: state => calls.push(['classify', state]),
      archive: () => calls.push(['archive']),
    });

    assert.equal(dispatchHoveredGtdShortcut('gtdTodo'), true);
    assert.equal(dispatchHoveredGtdShortcut('gtdWatch'), true);
    assert.equal(dispatchHoveredGtdShortcut('archive'), true);
    assert.deepEqual(calls, [
      ['classify', 'todo'],
      ['classify', 'watch'],
      ['archive'],
    ]);

    clearHoveredGtdRow(token);
  });

  it('leaves other actions and normal selected-row routing alone', () => {
    const token = registerHoveredGtdRow({
      classify: () => assert.fail('unsupported action must not classify the hovered row'),
      archive: () => assert.fail('unsupported action must not archive the hovered row'),
    });

    assert.equal(dispatchHoveredGtdShortcut('gtdDelegated'), false);
    assert.equal(dispatchHoveredGtdShortcut('toggleStar'), false);
    clearHoveredGtdRow(token);
    assert.equal(dispatchHoveredGtdShortcut('gtdTodo'), false);
  });

  it('does not let an older row clear the row that most recently took hover', () => {
    const calls = [];
    const first = registerHoveredGtdRow({
      classify: () => calls.push('first'), archive: () => calls.push('first'),
    });
    const second = registerHoveredGtdRow({
      classify: state => calls.push(`second:${state}`), archive: () => calls.push('second'),
    });

    assert.equal(clearHoveredGtdRow(first), false);
    assert.equal(dispatchHoveredGtdShortcut('gtdTodo'), true);
    assert.deepEqual(calls, ['second:todo']);

    clearHoveredGtdRow(second);
  });
});
