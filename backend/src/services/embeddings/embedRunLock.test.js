import { describe, it, expect, beforeEach } from 'vitest';
import { tryAcquireEmbedRun, releaseEmbedRun, isEmbedRunActive } from './embedRunLock.js';

beforeEach(() => releaseEmbedRun());

describe('embedRunLock (single-flight)', () => {
  it('grants the first acquire and refuses a second while held', () => {
    expect(isEmbedRunActive()).toBe(false);
    expect(tryAcquireEmbedRun()).toBe(true);
    expect(isEmbedRunActive()).toBe(true);
    expect(tryAcquireEmbedRun()).toBe(false); // second caller (scheduler vs manual build) is refused
  });

  it('re-acquires after release', () => {
    expect(tryAcquireEmbedRun()).toBe(true);
    releaseEmbedRun();
    expect(isEmbedRunActive()).toBe(false);
    expect(tryAcquireEmbedRun()).toBe(true);
  });
});
