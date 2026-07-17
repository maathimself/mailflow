import { vi } from 'vitest';

// Mock-drift guard. Given a mocked module namespace (`import * as ns` from a
// vi.mock'd module, or a hand-built `{ fnA, fnB }` of its named imports) and the
// real module (`await vi.importActual(path)`), return the names that are mocked
// as functions but do NOT exist as functions on the real module. A non-empty
// result means a suite invented a seam the production module never implemented —
// e.g. `generations.chunkCount`, mocked as a vi.fn() in two suites while the real
// module never exported it, which made live `collectStats` throw and silently drop
// get_stats' vector_search block.
//
// Scope note: this catches the missing/renamed EXPORT drift class only, not
// value-shape drift (a mock whose fn returns the wrong row shape still passes —
// the earlier message_id/id bug would not have been caught here). Pair it with
// real-shape fixtures where the return shape is load-bearing.
export function mockSurfaceDrift(mockedNs, realNs) {
  const drift = [];
  for (const [name, value] of Object.entries(mockedNs)) {
    if (vi.isMockFunction(value) && typeof realNs[name] !== 'function') {
      drift.push(name);
    }
  }
  return drift;
}
