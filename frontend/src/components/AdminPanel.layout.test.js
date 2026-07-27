import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const source = readFileSync(new URL('./AdminPanel.jsx', import.meta.url), 'utf8');

describe('conversation mode layout', () => {
  it('keeps all three mode cards in one equal-width row', () => {
    const start = source.indexOf('{/* Threading mode */}');
    const end = source.indexOf('{/* Mark as read behaviour */}', start);
    assert.notEqual(start, -1);
    assert.notEqual(end, -1);

    const block = source.slice(start, end);
    assert.match(block, /<div style=\{\{ display: 'flex', gap: 8 \}\}>/);
    assert.doesNotMatch(block, /flexWrap/);
    assert.match(block, /flex: 1, minWidth: 0, padding: '10px 12px'/);
    assert.equal((block.match(/overflowWrap: 'anywhere'/g) || []).length, 2);
  });
});
