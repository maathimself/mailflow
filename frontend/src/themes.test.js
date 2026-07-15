// Run with: node --test src/themes.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { THEMES } from './themes.js';

const names = Object.keys(THEMES);

// The canonical CSS-variable contract every theme must satisfy is taken from the
// first theme rather than a hardcoded list — so the check tracks the real set and a
// var added to every theme can never drift out of sync with this test.
const [reference] = names;
const canonicalVars = Object.keys(THEMES[reference].vars);

// One theme (parchment) intentionally carries a var the others don't need
// (--selection-bg, a sepia selection tint that only the light parchment surface
// wants). The invariant we pin is "no theme silently OMITS a canonical var", so
// extras beyond the canonical set are tolerated only from this known list — a *new*
// stray var still trips the guard and has to be justified (added everywhere or listed).
const KNOWN_THEME_EXTRAS = new Set(['--selection-bg']);

describe('THEMES CSS-var contract', () => {
  it('every theme defines all canonical CSS vars (no silent omissions)', () => {
    for (const name of names) {
      const keys = new Set(Object.keys(THEMES[name].vars));
      const missing = canonicalVars.filter(v => !keys.has(v));
      assert.deepEqual(missing, [], `${name} is missing vars: ${missing.join(', ')}`);
    }
  });

  it('no theme introduces an unexpected CSS var beyond the canonical set', () => {
    const canonical = new Set(canonicalVars);
    for (const name of names) {
      const extras = Object.keys(THEMES[name].vars)
        .filter(v => !canonical.has(v) && !KNOWN_THEME_EXTRAS.has(v));
      assert.deepEqual(extras, [], `${name} has unexpected vars: ${extras.join(', ')}`);
    }
  });

  it('every theme preview is an array of the same arity', () => {
    const arity = THEMES[reference].preview.length;
    for (const name of names) {
      assert.ok(Array.isArray(THEMES[name].preview), `${name} preview must be an array`);
      assert.equal(THEMES[name].preview.length, arity, `${name} preview arity differs from ${reference}`);
    }
  });
});
