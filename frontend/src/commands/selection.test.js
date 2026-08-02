import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { nextSelection } from './selection.js';

describe('nextSelection', () => {
  it('clones direct Sets and deduplicates iterables', () => {
    const input = new Set(['row-a']);
    const output = nextSelection(input, input);
    assert.deepEqual([...output], ['row-a']);
    assert.notStrictEqual(output, input);
    assert.deepEqual([...nextSelection(input, ['row-a', 'row-a', 'row-b'])], ['row-a', 'row-b']);
  });

  it('runs updater functions against a defensive Set copy', () => {
    const input = new Set(['row-a']);
    const output = nextSelection(input, current => current.add('row-b'));
    assert.deepEqual([...input], ['row-a']);
    assert.deepEqual([...output], ['row-a', 'row-b']);
  });
});
