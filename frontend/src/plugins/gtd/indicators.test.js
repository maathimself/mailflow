import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildInboxGtdIndicators, shouldShowInboxGtdMetadata } from './indicators.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-08-20T00:00:00.000Z');
const t = key => key;

describe('buildInboxGtdIndicators', () => {
  it('deduplicates valid states into canonical display order', () => {
    const result = buildInboxGtdIndicators({
      states: ['someday', 'watch', 'todo', 'watch', 'reference', 'delegated'],
      dates: {},
      date: null,
    }, t, NOW);

    assert.deepEqual(result.map(item => item.state), ['todo', 'watch', 'delegated', 'reference', 'someday']);
    assert.equal(result[0].label, 'gtd.state.todo');
  });

  it('shows whole-day aging for waiting states and turns stale after 14 days', () => {
    const fourteen = new Date(NOW - 14 * DAY).toISOString();
    const fifteen = new Date(NOW - 15 * DAY).toISOString();
    const result = buildInboxGtdIndicators({
      states: ['watch', 'delegated'],
      dates: { watch: fourteen, delegated: fifteen },
      date: fifteen,
    }, t, NOW);

    assert.deepEqual(result.map(item => ({ state: item.state, label: item.label, stale: item.stale })), [
      { state: 'watch', label: '⏱ 14d', stale: false },
      { state: 'delegated', label: '⏱ 15d', stale: true },
    ]);
    assert.notEqual(result[0].color, result[1].color);
  });

  it('uses a ten-day aging label without marking the waiting state stale', () => {
    const result = buildInboxGtdIndicators({
      states: ['watch'],
      dates: { watch: new Date(NOW - 10 * DAY).toISOString() },
    }, t, NOW);
    assert.equal(result[0].label, '⏱ 10d');
    assert.equal(result[0].stale, false);
  });

  it('preserves an explicit unknown waiting date instead of borrowing another state date', () => {
    const result = buildInboxGtdIndicators({
      states: ['watch', 'todo'],
      dates: { watch: null, todo: new Date(NOW - 20 * DAY).toISOString() },
      date: new Date(NOW - 20 * DAY).toISOString(),
    }, t, NOW);

    assert.equal(result.find(item => item.state === 'watch').label, 'gtd.state.watch');
    assert.equal(result.find(item => item.state === 'watch').stale, false);
  });

  it('returns no indicators for malformed metadata', () => {
    assert.deepEqual(buildInboxGtdIndicators(null, t, NOW), []);
    assert.deepEqual(buildInboxGtdIndicators({ states: 'todo' }, t, NOW), []);
    assert.deepEqual(buildInboxGtdIndicators({ states: ['invalid'] }, t, NOW), []);
  });
});

describe('shouldShowInboxGtdMetadata', () => {
  it('shows metadata in Inbox and active search results only', () => {
    assert.equal(shouldShowInboxGtdMetadata({ selectedFolder: 'INBOX', searchQuery: '' }), true);
    assert.equal(shouldShowInboxGtdMetadata({ selectedFolder: 'Sent', searchQuery: 'casey' }), true);
    assert.equal(shouldShowInboxGtdMetadata({ selectedFolder: 'Sent', searchQuery: '' }), false);
    assert.equal(shouldShowInboxGtdMetadata({ selectedFolder: 'Trash', searchQuery: '   ' }), false);
  });
});
