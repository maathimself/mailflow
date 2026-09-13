import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDate } from './formatDate.js';

// Local-time dates relative to now, so the expectations hold in any timezone.
function localDate(daysAgo, hours, minutes) {
  const d = new Date();
  d.setHours(hours, minutes, 0, 0);
  d.setDate(d.getDate() - daysAgo);
  return d;
}

test('formatDate shows a 12-hour time for today', () => {
  assert.equal(formatDate(localDate(0, 9, 5).toISOString()), '9:05 AM');
  assert.equal(formatDate(localDate(0, 15, 30).toISOString()), '3:30 PM');
});

test('formatDate labels yesterday', () => {
  assert.equal(formatDate(localDate(1, 12, 0).toISOString()), 'Yesterday');
});

test('formatDate shows month and day for older dates in the current year, and adds the year otherwise', () => {
  const now = new Date();
  // Pick a date in the current year that is neither today nor yesterday.
  const thisYear = now.getMonth() === 0 && now.getDate() <= 2
    ? null
    : new Date(now.getFullYear(), 0, 1, 12, 0, 0);
  if (thisYear) {
    assert.equal(formatDate(thisYear.toISOString()), 'Jan 1');
  }
  const lastYear = new Date(now.getFullYear() - 1, 2, 7, 12, 0, 0);
  assert.equal(formatDate(lastYear.toISOString()), `Mar 7, ${now.getFullYear() - 1}`);
});

test('formatDate returns an empty string for missing or invalid input', () => {
  assert.equal(formatDate(''), '');
  assert.equal(formatDate(null), '');
  assert.equal(formatDate(undefined), '');
  assert.equal(formatDate('not a date'), '');
});
