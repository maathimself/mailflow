// Run with: node --test src/utils/folderDisplay.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  favoriteMoveTargets,
  recentMoveTargets,
  folderDelimiter,
  folderMatchesQuery,
  folderParentLabel,
  folderParentPath,
  folderDisplayName,
  folderRole,
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

describe('folderDisplayName', () => {
  const t = key => ({
    'folders.inbox': 'Caixa de entrada', 'folders.sent': 'Enviados', 'folders.drafts': 'Rascunhos',
    'folders.trash': 'Lixeira', 'folders.spam': 'Spam', 'folders.archive': 'Arquivo',
  })[key] ?? key;

  it('translates special-use folders by role, not by server name', () => {
    assert.equal(folderDisplayName({ path: 'Sent', name: 'Sent', special_use: '\\Sent' }, t), 'Enviados');
    assert.equal(folderDisplayName({ path: 'Junk', name: 'Junk', special_use: '\\Junk' }, t), 'Spam');
    assert.equal(folderDisplayName({ path: 'Papierkorb', name: 'Papierkorb', special_use: '\\Trash' }, t), 'Lixeira');
    assert.equal(folderDisplayName({ path: '[Gmail]/All Mail', name: 'All Mail', special_use: '\\All' }, t), 'All Mail');
  });

  it('recognizes INBOX by name even without a special-use flag', () => {
    assert.equal(folderDisplayName({ path: 'INBOX', name: 'INBOX' }, t), 'Caixa de entrada');
    assert.equal(folderDisplayName({ path: 'inbox', name: 'inbox' }, t), 'Caixa de entrada');
    assert.equal(folderDisplayName({ path: 'INBOX/Work', name: 'Work' }, t), 'Work');
  });

  it('falls back to the account folder mappings when the server sets no flag', () => {
    const mappings = { archive: 'Archives', trash: 'Deleted Items' };
    assert.equal(folderDisplayName({ path: 'Archives', name: 'Archives' }, t, mappings), 'Arquivo');
    assert.equal(folderDisplayName({ path: 'Deleted Items', name: 'Deleted Items' }, t, mappings), 'Lixeira');
    assert.equal(folderDisplayName({ path: 'Notes', name: 'Notes' }, t, mappings), 'Notes');
  });

  it('keeps the server name when no translation exists or t is missing', () => {
    assert.equal(folderDisplayName({ path: 'Sent', name: 'Sent', special_use: '\\Sent' }, key => key), 'Sent');
    assert.equal(folderDisplayName({ path: 'Sent', name: 'Sent', special_use: '\\Sent' }), 'Sent');
    assert.equal(folderDisplayName({ path: 'Sent', special_use: '\\Sent' }, undefined), 'Sent');
  });

  it('exposes the role for callers that only need it', () => {
    assert.equal(folderRole({ path: 'Drafts', special_use: '\\Drafts' }), 'drafts');
    assert.equal(folderRole({ path: 'Projects' }), null);
    assert.equal(folderRole({}), null);
  });
});

describe('favoriteMoveTargets (#505)', () => {
  const folders = [
    { path: 'INBOX', name: 'INBOX' },
    { path: 'Work/Receipts', name: 'Receipts' },
    { path: 'Archive', name: 'Archive' },
  ];
  const favorites = [
    { accountId: 'a', path: 'Work/Receipts', label: 'Tax 2026' },
    { accountId: 'a', path: 'Archive' },
    { accountId: 'b', path: 'Archive', label: 'Other account' },
    { accountId: 'a', path: 'Gone' },
  ];

  it('carries the custom name of a renamed favorite', () => {
    const out = favoriteMoveTargets(favorites, folders, { accountId: 'a', currentFolder: 'INBOX' });
    assert.deepEqual(out.map(f => [f.path, f.favoriteLabel]), [['Work/Receipts', 'Tax 2026'], ['Archive', undefined]]);
  });

  it('keeps the existing filters: account, current folder, missing folders, entries listed elsewhere', () => {
    const out = favoriteMoveTargets(favorites, folders, { accountId: 'a', currentFolder: 'Archive', exclude: [{ path: 'Work/Receipts' }] });
    assert.deepEqual(out, []);
  });

  it('does not mutate the picker\'s folder objects', () => {
    favoriteMoveTargets(favorites, folders, { accountId: 'a' });
    assert.equal(folders[1].favoriteLabel, undefined);
  });
});

describe('recentMoveTargets (#551)', () => {
  const folders = [
    { path: 'INBOX', name: 'INBOX' },
    { path: 'Work/Receipts', name: 'Receipts' },
    { path: 'Archive', name: 'Archive' },
  ];
  const recents = [
    { accountId: 'a', path: 'Archive' },
    { accountId: 'b', path: 'Work/Receipts' },
    { accountId: 'a', path: 'Deleted since' },
    { accountId: 'a', path: 'INBOX' },
    { accountId: 'a', path: 'Work/Receipts' },
  ];

  it('returns the account\'s recent folders newest first, as the picker\'s folder objects', () => {
    const out = recentMoveTargets(recents, folders, { accountId: 'a', currentFolder: 'INBOX' });
    assert.deepEqual(out, [folders[2], folders[1]]);
  });

  it('drops the current folder, other accounts and folders that no longer exist', () => {
    assert.deepEqual(recentMoveTargets(recents, folders, { accountId: 'a', currentFolder: 'Archive' }).map(f => f.path), ['INBOX', 'Work/Receipts']);
    assert.deepEqual(recentMoveTargets(recents, folders, { accountId: 'b', currentFolder: 'Work/Receipts' }), []);
  });

  it('tolerates missing lists', () => {
    assert.deepEqual(recentMoveTargets(undefined, folders, { accountId: 'a' }), []);
    assert.deepEqual(recentMoveTargets(recents, undefined, { accountId: 'a' }), []);
  });
});
