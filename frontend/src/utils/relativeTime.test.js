// Run with: node --test src/utils/relativeTime.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatRelativeTime, daysSince } from './relativeTime.js';

const NOW = Date.parse('2026-09-28T12:00:00Z');
const ago = seconds => new Date(NOW - seconds * 1000).toISOString();

describe('formatRelativeTime', () => {
  it('picks the largest whole unit, in the requested language', () => {
    assert.equal(formatRelativeTime(ago(3 * 86400), 'pt-BR', NOW), 'há 3 dias');
    assert.equal(formatRelativeTime(ago(3 * 86400), 'en', NOW), '3 days ago');
    assert.equal(formatRelativeTime(ago(2 * 3600), 'en', NOW), '2 hours ago');
    assert.equal(formatRelativeTime(ago(95 * 86400), 'en', NOW), '3 months ago');
  });

  it('says "now" for the last minute and "yesterday" for a day ago', () => {
    assert.equal(formatRelativeTime(ago(20), 'en', NOW), 'now');
    assert.equal(formatRelativeTime(ago(86400), 'en', NOW), 'yesterday');
  });

  it('returns nothing for a missing or unreadable date', () => {
    assert.equal(formatRelativeTime(null, 'en', NOW), '');
    assert.equal(formatRelativeTime('não é data', 'en', NOW), '');
  });
});

describe('daysSince', () => {
  it('counts days, and treats a missing date as never', () => {
    assert.equal(daysSince(ago(2 * 86400), NOW), 2);
    assert.equal(daysSince(null, NOW), Infinity);
  });
});
