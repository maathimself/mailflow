// Run with: node --test src/utils/folderDisplay.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  folderDelimiter,
  folderMatchesQuery,
  folderParentLabel,
  folderParentPath,
} from './folderDisplay.js';

describe('folderDelimiter', () => {
  it('uses the folder delimiter and falls back to a slash', () => {
    assert.equal(folderDelimiter({ delimiter: '.' }), '.');
    assert.equal(folderDelimiter({ delimiter: '' }), '/');
    assert.equal(folderDelimiter({}), '/');
    assert.equal(folderDelimiter(null), '/');
  });
});

describe('folderParentPath', () => {
  it('returns the parent path and null at the root', () => {
    assert.equal(folderParentPath('Projects/Alpha', '/'), 'Projects');
    assert.equal(folderParentPath('INBOX.Receipts.Amazon', '.'), 'INBOX.Receipts');
    assert.equal(folderParentPath('Archive', '/'), null);
  });
});

describe('folderParentLabel', () => {
  it('is empty for root-level folders', () => {
    assert.equal(folderParentLabel({ path: 'Archive', name: 'Archive', delimiter: '/' }), '');
  });

  it('shows the parent for one level of nesting', () => {
    assert.equal(
      folderParentLabel({ path: 'ML Vending/SeedLive', name: 'SeedLive', delimiter: '/' }),
      'ML Vending',
    );
  });

  it('joins deeper ancestor chains for humans', () => {
    assert.equal(
      folderParentLabel({ path: 'Personal/Insurance/2024', name: '2024', delimiter: '/' }),
      'Personal / Insurance',
    );
  });

  it('respects dot-delimiter accounts', () => {
    assert.equal(
      folderParentLabel({ path: 'INBOX.Receipts.Amazon', name: 'Amazon', delimiter: '.' }),
      'INBOX / Receipts',
    );
  });

  it('tolerates folders without a path', () => {
    assert.equal(folderParentLabel({ name: 'Orphan' }), '');
    assert.equal(folderParentLabel(null), '');
  });
});

describe('folderMatchesQuery', () => {
  const folder = { path: 'ML Vending/SeedLive', name: 'SeedLive', delimiter: '/' };

  it('matches everything on an empty query', () => {
    assert.equal(folderMatchesQuery(folder, ''), true);
    assert.equal(folderMatchesQuery(folder, '   '), true);
    assert.equal(folderMatchesQuery(folder, null), true);
  });

  it('matches the folder name case-insensitively', () => {
    assert.equal(folderMatchesQuery(folder, 'seedlive'), true);
    assert.equal(folderMatchesQuery(folder, 'SEED'), true);
  });

  it('matches the parent segment of the path', () => {
    assert.equal(folderMatchesQuery(folder, 'vending'), true);
  });

  it('matches a parent/child query across the delimiter', () => {
    assert.equal(folderMatchesQuery(folder, 'vending/seed'), true);
  });

  it('matches parent/child queries on dot-delimiter accounts too', () => {
    const dotted = { path: 'INBOX.Receipts.Amazon', name: 'Amazon', delimiter: '.' };
    assert.equal(folderMatchesQuery(dotted, 'receipts/amazon'), true);
    assert.equal(folderMatchesQuery(dotted, 'receipts.amazon'), true);
  });

  it('rejects folders that match nowhere', () => {
    assert.equal(folderMatchesQuery(folder, 'taxes'), false);
  });

  it('does not false-match a slash query against a name containing a dot', () => {
    // '/'-delimited account whose folder NAME contains a '.' — the '.' is part
    // of the name, not hierarchy, so a '/'-separated query must not split it.
    const dotted = { path: 'Reports/2024.05', name: '2024.05', delimiter: '/' };
    assert.equal(folderMatchesQuery(dotted, '2024/05'), false);
    assert.equal(folderMatchesQuery(dotted, '2024.05'), true);
    assert.equal(folderMatchesQuery(dotted, 'reports/2024'), true);
    assert.equal(folderParentLabel(dotted), 'Reports');
  });

  it('matches the literal name of a folder whose name contains a slash', () => {
    // '.'-delimited account whose folder NAME contains a '/'. Its literal name
    // must stay searchable, and the parent chain must come from the real
    // delimiter, not the slash inside the name.
    const slashed = { path: 'INBOX.a/b', name: 'a/b', delimiter: '.' };
    assert.equal(folderMatchesQuery(slashed, 'a/b'), true);
    assert.equal(folderMatchesQuery(slashed, 'inbox.a'), true);
    assert.equal(folderParentLabel(slashed), 'INBOX');
  });
});
