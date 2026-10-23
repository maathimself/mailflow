// Run with: node --test src/utils/folderDisplay.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMovePickerSections,
  movePickerSectionHeading,
  movePickerFoldersEmpty,
  runMovePickerAction,
  favoriteMoveTargets,
  recentMoveTargets,
  folderDelimiter,
  folderMatchesQuery,
  folderParentLabel,
  folderParentPath,
  folderDisplayName,
  folderDisplayNameForPath,
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

  // #623: imapflow flags one Trash per account and, between name matches, the alphabetically
  // first, so a client-made "Deleted Items" takes the flag from "Trash". Both rows read "Trash".
  it('keeps the server name when the role label would repeat another folder in the account', () => {
    const en = key => ({ 'folders.trash': 'Trash', 'folders.sent': 'Sent' })[key] ?? key;
    const folders = [
      { path: 'Deleted Items', name: 'Deleted Items', special_use: '\\Trash' },
      { path: 'Trash', name: 'Trash', special_use: null },
      { path: 'Sent', name: 'Sent', special_use: '\\Sent' },
    ];
    const names = folders.map(f => folderDisplayName(f, en, {}, folders));
    assert.deepEqual(names, ['Deleted Items', 'Trash', 'Sent']);
  });

  it('gives a role label to the mapped folder only, not also to the flagged one', () => {
    const folders = [
      { path: 'Trash', name: 'Trash', special_use: '\\Trash' },
      { path: 'Deleted Items', name: 'Deleted Items', special_use: null },
    ];
    const mappings = { trash: 'Deleted Items' };
    const names = folders.map(f => folderDisplayName(f, t, mappings, folders));
    assert.deepEqual(names, ['Trash', 'Lixeira']);
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

// The empty and delete confirmations, the "Emptying" notice and the message list header name a
// folder by its path; they read as the sidebar does (#623 follow-up).
describe('folderDisplayNameForPath', () => {
  const en = key => ({ 'folders.trash': 'Trash', 'folders.spam': 'Spam', 'folders.archive': 'Archive', 'folders.inbox': 'Inbox' })[key] ?? key;

  it('names SmarterMail\'s "Deleted Items" Trash, as the sidebar labels it', () => {
    const folders = [
      { path: 'INBOX', name: 'INBOX' },
      { path: 'Deleted Items', name: 'Deleted Items', special_use: '\\Trash' },
      { path: 'Junk E-mail', name: 'Junk E-mail', special_use: '\\Junk' },
    ];
    assert.equal(folderDisplayNameForPath('Deleted Items', en, {}, folders), 'Trash');
    assert.equal(folderDisplayNameForPath('Junk E-mail', en, {}, folders), 'Spam');
    assert.equal(folderDisplayNameForPath('INBOX', en, {}, folders), 'Inbox');
  });

  it('agrees with the sidebar when a second folder already carries the label', () => {
    const folders = [
      { path: 'Deleted Items', name: 'Deleted Items', special_use: '\\Trash' },
      { path: 'Trash', name: 'Trash', special_use: null },
    ];
    assert.equal(folderDisplayNameForPath('Deleted Items', en, {}, folders), 'Deleted Items');
    assert.equal(folderDisplayNameForPath('Trash', en, {}, folders), 'Trash');
  });

  it('uses the account folder mappings', () => {
    const folders = [{ path: 'INBOX.Old', name: 'Old', delimiter: '.' }];
    assert.equal(folderDisplayNameForPath('INBOX.Old', en, { archive: 'INBOX.Old' }, folders), 'Archive');
  });

  it('keeps a folder without a role as its server name', () => {
    const folders = [{ path: 'Work/Clients', name: 'Clients', delimiter: '/' }];
    assert.equal(folderDisplayNameForPath('Work/Clients', en, {}, folders), 'Clients');
  });

  it('reads a folder missing from the list as its last segment, or its mapped role', () => {
    const folders = [{ path: 'INBOX', name: 'INBOX', delimiter: '.' }];
    assert.equal(folderDisplayNameForPath('INBOX.Receipts', en, {}, folders), 'Receipts');
    assert.equal(folderDisplayNameForPath('INBOX.Trash', en, { trash: 'INBOX.Trash' }, folders), 'Trash');
    assert.equal(folderDisplayNameForPath('Projects/Alpha', en, {}, undefined), 'Alpha');
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

describe('buildMovePickerSections', () => {
  const folders = ['INBOX', 'Archive', 'Todo', 'Watch', 'Drafts'].map(path => ({ path, name: path }));
  const recents = [{ accountId: 'a', path: 'Watch' }, { accountId: 'a', path: 'Archive' }];
  const favorites = [{ accountId: 'a', path: 'Archive' }, { accountId: 'a', path: 'Drafts', label: 'Drafts!' }];
  const item = (key, label, path) => ({ key, label, path, renderIcon: () => null, onSelect: () => {} });
  const gtd = { key: 'gtd', heading: 'GTD', items: [item('todo', 'Todo', 'Todo'), item('watch', 'Watch', 'Watch')] };
  const base = { folders, recents, favorites, accountId: 'a', currentFolder: 'INBOX' };
  const paths = section => section.rows.map(r => r.folder.path);
  const byKey = (sections, key) => sections.find(s => s.key === key);

  it('no plugin sections reproduces today\'s picker', () => {
    const sections = buildMovePickerSections(base);
    const recent = recentMoveTargets(recents, folders, { accountId: 'a', currentFolder: 'INBOX' });
    const favs = favoriteMoveTargets(favorites, folders, { accountId: 'a', currentFolder: 'INBOX', exclude: recent });
    assert.deepEqual(sections.map(s => [s.key, s.heading]), [['recent', null], ['favorites', null], ['all', null]]);
    assert.deepEqual(byKey(sections, 'recent').rows, recent.map(folder => ({ kind: 'folder', folder })));
    assert.deepEqual(byKey(sections, 'favorites').rows, favs.map(folder => ({ kind: 'folder', folder })));
    assert.deepEqual(paths(byKey(sections, 'all')), ['Archive', 'Todo', 'Watch', 'Drafts']);
  });

  it('favorite rows keep the favorite\'s custom name', () => {
    const sections = buildMovePickerSections(base);
    assert.deepEqual(byKey(sections, 'favorites').rows.map(r => r.folder.favoriteLabel), ['Drafts!']);
  });

  it('plugin sections come first and their paths leave every core section', () => {
    const sections = buildMovePickerSections({ ...base, pluginSections: [gtd] });
    assert.deepEqual(sections.map(s => s.key), ['plugin:gtd', 'recent', 'favorites', 'all']);
    const g = byKey(sections, 'plugin:gtd');
    assert.equal(g.heading, 'GTD');
    assert.deepEqual(g.rows, gtd.items.map(i => ({ kind: 'action', item: i })));
    for (const key of ['recent', 'favorites', 'all']) {
      const p = paths(byKey(sections, key));
      assert.ok(!p.includes('Todo') && !p.includes('Watch'), `${key} still lists a plugin path: ${p}`);
    }
  });

  it('an item for the current folder is hidden', () => {
    const sections = buildMovePickerSections({ ...base, currentFolder: 'Watch', pluginSections: [gtd] });
    assert.deepEqual(byKey(sections, 'plugin:gtd').rows.map(r => r.item.key), ['todo']);
    for (const s of sections.filter(s => s.key !== 'plugin:gtd')) {
      assert.ok(!paths(s).includes('Watch'));
    }
    const inArchive = buildMovePickerSections({ ...base, currentFolder: 'Archive', pluginSections: [gtd] });
    assert.deepEqual(byKey(inArchive, 'plugin:gtd').rows.map(r => r.item.key), ['todo', 'watch']);
    for (const s of inArchive.filter(s => s.key !== 'plugin:gtd')) {
      assert.ok(!paths(s).includes('Archive'), `${s.key} lists the current folder`);
    }
    assert.ok(paths(byKey(inArchive, 'all')).includes('Drafts'));
  });

  it('a query filters item labels and folders, without recent or favorites', () => {
    const arc = buildMovePickerSections({ ...base, pluginSections: [gtd], query: ' Arc ' });
    assert.deepEqual(arc.map(s => s.key), ['all']);
    assert.deepEqual(paths(arc[0]), ['Archive']);

    const tod = buildMovePickerSections({ ...base, pluginSections: [gtd], query: 'tod' });
    assert.deepEqual(tod.map(s => s.key), ['plugin:gtd']);
    assert.deepEqual(tod[0].rows.map(r => r.item.key), ['todo']);
  });

  it('a query finds an item by its folder when the label differs', () => {
    const german = { key: 'gtd', heading: 'GTD', items: [item('todo', 'Aufgabe', 'Todo')] };
    const found = buildMovePickerSections({ ...base, pluginSections: [german], query: 'todo' });
    assert.deepEqual(byKey(found, 'plugin:gtd').rows.map(r => r.item.key), ['todo']);
    const noFolder = buildMovePickerSections({ ...base, folders: [], pluginSections: [german], query: 'todo' });
    assert.deepEqual(byKey(noFolder, 'plugin:gtd').rows.map(r => r.item.key), ['todo']);

    const renamed = { key: 'gtd', heading: 'GTD', items: [item('todo', 'Todo', '@Next Actions')] };
    const next = buildMovePickerSections({
      ...base,
      folders: [...folders, { path: '@Next Actions', name: '@Next Actions' }],
      pluginSections: [renamed],
      query: 'next',
    });
    assert.deepEqual(byKey(next, 'plugin:gtd').rows.map(r => r.item.key), ['todo']);
    assert.ok(!(byKey(next, 'all')?.rows || []).some(r => r.folder.path === '@Next Actions'));
  });

  it('empty sections are dropped', () => {
    const sections = buildMovePickerSections({ ...base, recents: [], favorites: [], pluginSections: [gtd] });
    assert.deepEqual(sections.map(s => s.key), ['plugin:gtd', 'all']);
    const none = buildMovePickerSections({ ...base, pluginSections: [{ key: 'empty', heading: 'E', items: [] }] });
    assert.deepEqual(none.map(s => s.key), ['recent', 'favorites', 'all']);
  });

  it('a plugin section keyed like a core section stays apart from it', () => {
    const clash = { key: 'all', heading: 'X', items: [item('todo', 'Todo', 'Todo')] };
    const sections = buildMovePickerSections({ ...base, pluginSections: [clash] });
    assert.deepEqual(sections.map(s => [s.key, s.heading]), [
      ['plugin:all', 'X'], ['recent', null], ['favorites', null], ['all', null],
    ]);
    assert.equal(new Set(sections.map(s => s.key)).size, sections.length);
  });

  it('two plugin sections with the same key get distinct keys', () => {
    const a = { key: 'gtd', heading: 'A', items: [item('todo', 'Todo', 'Todo')] };
    const b = { key: 'gtd', heading: 'B', items: [item('watch', 'Watch', 'Watch')] };
    const c = { key: 'gtd', heading: 'C', items: [item('arc', 'Arc', 'Archive')] };
    const sections = buildMovePickerSections({ ...base, pluginSections: [a, b, c] });
    assert.deepEqual(sections.slice(0, 3).map(s => [s.key, s.heading]), [
      ['plugin:gtd', 'A'], ['plugin:gtd-2', 'B'], ['plugin:gtd-3', 'C'],
    ]);
    assert.equal(new Set(sections.map(s => s.key)).size, sections.length);
  });

  it('a suffixed key never collides with a plugin section already keyed that way', () => {
    const sections = buildMovePickerSections({ ...base, pluginSections: [
      { key: 'gtd', heading: 'A', items: [item('todo', 'Todo', 'Todo')] },
      { key: 'gtd-2', heading: 'B', items: [item('watch', 'Watch', 'Watch')] },
      { key: 'gtd', heading: 'C', items: [item('arc', 'Arc', 'Archive')] },
    ] });
    assert.equal(new Set(sections.map(s => s.key)).size, sections.length);
  });

  it('plugin sections survive an empty or failed folder list', () => {
    const sections = buildMovePickerSections({ ...base, folders: [], pluginSections: [gtd] });
    assert.deepEqual(sections.map(s => s.key), ['plugin:gtd']);
    assert.deepEqual(byKey(sections, 'plugin:gtd').rows.map(r => r.item.key), ['todo', 'watch']);
  });
});

describe('movePickerFoldersEmpty', () => {
  const action = { key: 'plugin:gtd', heading: 'GTD', rows: [{ kind: 'action', item: {} }] };
  const all = { key: 'all', heading: null, rows: [{ kind: 'folder', folder: { path: 'Archive' } }] };

  it('an empty or missing folder list shows the empty message, beside any plugin sections', () => {
    assert.equal(movePickerFoldersEmpty([action], []), true);
    assert.equal(movePickerFoldersEmpty([action], null), true);
    assert.equal(movePickerFoldersEmpty([], undefined), true);
  });

  it('nothing to show at all shows the empty message', () => {
    assert.equal(movePickerFoldersEmpty([], [{ path: 'Archive' }]), true);
  });

  it('folders, or a search matching only plugin items, show no empty message', () => {
    assert.equal(movePickerFoldersEmpty([all], [{ path: 'Archive' }]), false);
    assert.equal(movePickerFoldersEmpty([action], [{ path: 'Archive' }]), false);
  });
});

describe('runMovePickerAction', () => {
  it('runs the item, then closes', () => {
    const calls = [];
    runMovePickerAction({ onSelect: () => calls.push('select') }, () => calls.push('close'));
    assert.deepEqual(calls, ['select', 'close']);
  });

  it('closes the picker even when the item throws', () => {
    let closed = false;
    assert.throws(
      () => runMovePickerAction({ onSelect: () => { throw new Error('boom'); } }, () => { closed = true; }),
      /boom/,
    );
    assert.equal(closed, true);
  });
});

describe('movePickerSectionHeading', () => {
  const t = key => `t:${key}`;

  it('a section\'s own heading wins, even under a core key', () => {
    assert.equal(movePickerSectionHeading({ key: 'recent', heading: 'X' }, t), 'X');
    assert.equal(movePickerSectionHeading({ key: 'all', heading: 'Y' }, t), 'Y');
    assert.equal(movePickerSectionHeading({ key: 'gtd', heading: 'GTD' }, t), 'GTD');
  });

  it('core sections take their translated headings, and all has none', () => {
    assert.equal(movePickerSectionHeading({ key: 'recent', heading: null }, t), 't:contextMenu.folders.recent');
    assert.equal(movePickerSectionHeading({ key: 'favorites', heading: null }, t), 't:contextMenu.folders.favorites');
    assert.equal(movePickerSectionHeading({ key: 'all', heading: null }, t), null);
  });
});
