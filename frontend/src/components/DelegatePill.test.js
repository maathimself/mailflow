import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('renders delegate identity on GTD, thread-list, flat-list, and open-message surfaces', () => {
  const gtd = fs.readFileSync(new URL('./GtdEntryRow.jsx', import.meta.url), 'utf8');
  const list = fs.readFileSync(new URL('./MessageList.jsx', import.meta.url), 'utf8');
  const pane = fs.readFileSync(new URL('./MessagePane.jsx', import.meta.url), 'utf8');
  assert.match(gtd, /<DelegatePill delegation=\{thread\.delegation\} compact/);
  assert.equal((list.match(/<DelegatePill delegation=\{message\.delegation\} compact/g) || []).length, 2);
  assert.match(pane, /<DelegatePill delegation=\{message\.delegation\}/);
});
