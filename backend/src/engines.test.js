import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const readJson = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));

// Lowest "major.minor.patch" named by a ">=" clause, as a comparable tuple.
function lowerBound(range) {
  const m = /^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(range.trim());
  if (!m) throw new Error(`No >= lower bound in engines range "${range}"`);
  return [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)];
}
const atLeast = (a, b) => a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] >= b[2];

describe('backend engines', () => {
  const pkg = readJson('../package.json');
  const lock = readJson('../package-lock.json');

  it('does not admit a Node version below what undici requires', () => {
    const undici = readJson('../node_modules/undici/package.json');
    expect(atLeast(lowerBound(pkg.engines.node), lowerBound(undici.engines.node))).toBe(true);
    expect(pkg.engines.node).toMatch(/<23$/);
  });

  it('keeps the lockfile root engines in step with package.json', () => {
    expect(lock.packages[''].engines).toEqual(pkg.engines);
  });
});
