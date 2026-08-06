import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

describe('CommandRuntimeContext source contract', () => {
  it('exports one provider and one strict consumer hook', () => {
    const source = fs.readFileSync(new URL('./CommandRuntimeContext.jsx', import.meta.url), 'utf8');
    assert.match(source, /export function CommandRuntimeProvider/);
    assert.match(source, /export function useCommandRuntimeContext/);
    assert.match(source, /must be used inside CommandRuntimeProvider/);
  });
});
