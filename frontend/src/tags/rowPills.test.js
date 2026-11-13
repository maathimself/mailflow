import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// MessageList has two row renderers (ThreadRow and MessageRow). Tag pills were once added to only
// one of them, so most rows showed none; every row that shows the spam badge must show the pills.
test('every message-list row renderer shows the tag pills', () => {
  const source = readFileSync(new URL('../components/MessageList.jsx', import.meta.url), 'utf8');
  const spamBadges = source.match(/<SpamBadge message=\{message\} onClick=\{onExplainSpam\} \/>/g) || [];
  const pills = source.match(/<RowTagPills message=\{message\} \/>/g) || [];
  assert.equal(spamBadges.length, 2, 'two row renderers expected');
  assert.equal(pills.length, spamBadges.length);
});

// Both screens load the list of tags; each one must reload when the list changes, or a tag created
// in Settings would not show in the picker until a refresh.
test('screens that list the tags depend on the definitions revision', () => {
  for (const file of ['TagPickerList.jsx', 'TagsSettings.jsx']) {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
    assert.match(source, /useTagDefinitionsRevision\(\)/, `${file} reads the revision`);
  }
  const settings = readFileSync(new URL('./TagsSettings.jsx', import.meta.url), 'utf8');
  assert.match(settings, /bumpTagDefinitions\(\)/, 'creating, editing or deleting a tag announces the change');
});
