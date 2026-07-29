// Run with: node --test src/utils/sidebar.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  activateOnKey,
  buildFolderTree,
  collapsedTooltip,
  FOLDER_ORDER_DRAG_TYPE,
  folderDropPosition,
  normalizeFolderOrder,
  reorderFolderPaths,
  resolveFolderOrderDrop,
  sanitizeFolderOrder,
} from './sidebar.js';

const folders = [
  { path: 'Archive', name: 'Archive', delimiter: '/' },
  { path: 'INBOX', name: 'INBOX', delimiter: '/' },
  { path: 'Projects', name: 'Projects', delimiter: '/' },
  { path: 'Projects/Alpha', name: 'Alpha', delimiter: '/' },
  { path: 'Projects/Beta', name: 'Beta', delimiter: '/' },
];

describe('collapsedTooltip', () => {
  it('surfaces the label as a tooltip while the rail is collapsed', () => {
    assert.equal(collapsedTooltip('jim@jimbob.com', true), 'jim@jimbob.com');
    assert.equal(collapsedTooltip('All Inboxes', true), 'All Inboxes');
  });

  it('gives no tooltip when expanded, where the label is already on screen', () => {
    assert.equal(collapsedTooltip('jim@jimbob.com', false), undefined);
  });

  it('gives no tooltip for an account with no address, rather than an empty one', () => {
    assert.equal(collapsedTooltip('', true), undefined);
    assert.equal(collapsedTooltip('   ', true), undefined);
    assert.equal(collapsedTooltip(undefined, true), undefined);
    assert.equal(collapsedTooltip(null, true), undefined);
  });
});

describe('activateOnKey', () => {
  const press = (key) => {
    const event = { key, prevented: false, preventDefault() { this.prevented = true; } };
    return event;
  };

  it('activates on Enter and on Space, as a real button would', () => {
    for (const key of ['Enter', ' ']) {
      let activated = 0;
      const event = press(key);
      activateOnKey(() => { activated += 1; })(event);
      assert.equal(activated, 1, `expected ${JSON.stringify(key)} to activate`);
    }
  });

  it('swallows the Space keypress so the rail does not scroll underneath', () => {
    const event = press(' ');
    activateOnKey(() => {})(event);
    assert.equal(event.prevented, true);
  });

  it('ignores every other key, leaving Tab and arrows to the browser', () => {
    for (const key of ['Tab', 'ArrowDown', 'a', 'Escape']) {
      let activated = 0;
      const event = press(key);
      activateOnKey(() => { activated += 1; })(event);
      assert.equal(activated, 0, `expected ${JSON.stringify(key)} to be ignored`);
      assert.equal(event.prevented, false, `expected ${JSON.stringify(key)} to pass through`);
    }
  });
});

describe('folder ordering', () => {
  it('sanitizes account order maps without duplicate or malformed paths', () => {
    assert.deepEqual(sanitizeFolderOrder({
      a1: ['INBOX', 'Archive', 'INBOX', 42, ''],
      a2: 'not-an-array',
    }), { a1: ['INBOX', 'Archive'] });
    assert.deepEqual(sanitizeFolderOrder(null), {});
    assert.deepEqual(sanitizeFolderOrder([]), {});
  });

  it('keeps the legacy alphabetical order without a saved preference', () => {
    const tree = buildFolderTree(folders);
    assert.deepEqual(tree.map(node => node.path), ['Archive', 'INBOX', 'Projects']);
    assert.deepEqual(tree[2].children.map(node => node.path), [
      'Projects/Alpha',
      'Projects/Beta',
    ]);
  });

  it('applies saved ranks independently to root and nested siblings', () => {
    const tree = buildFolderTree(folders, [
      'Projects',
      'INBOX',
      'Projects/Beta',
      'Projects/Alpha',
    ]);
    assert.deepEqual(tree.map(node => node.path), ['Projects', 'INBOX', 'Archive']);
    assert.deepEqual(tree[0].children.map(node => node.path), [
      'Projects/Beta',
      'Projects/Alpha',
    ]);
  });

  it('synthesizes and orders a missing ancestor without changing its hierarchy', () => {
    const tree = buildFolderTree([
      { path: 'Projects/Beta', name: 'Beta', delimiter: '/' },
      { path: 'Projects/Alpha', name: 'Alpha', delimiter: '/' },
    ], ['Projects/Beta', 'Projects/Alpha']);

    assert.deepEqual(tree.map(node => node.path), ['Projects']);
    assert.deepEqual(tree[0].children.map(node => node.path), [
      'Projects/Beta',
      'Projects/Alpha',
    ]);
  });

  it('puts new folders after ranked folders and ignores stale paths', () => {
    assert.deepEqual(
      normalizeFolderOrder(folders, ['Gone', 'INBOX', 'Archive', 'INBOX']),
      ['INBOX', 'Archive', 'Projects', 'Projects/Alpha', 'Projects/Beta'],
    );
  });

  it('moves a root sibling before or after its target', () => {
    assert.deepEqual(
      reorderFolderPaths(folders, [], 'Archive', 'Projects', 'after'),
      ['INBOX', 'Projects', 'Archive', 'Projects/Alpha', 'Projects/Beta'],
    );
    assert.deepEqual(
      reorderFolderPaths(folders, [], 'Projects', 'Archive', 'before'),
      ['Projects', 'Archive', 'INBOX', 'Projects/Alpha', 'Projects/Beta'],
    );
  });

  it('moves nested siblings without changing the parent hierarchy', () => {
    assert.deepEqual(
      reorderFolderPaths(folders, [], 'Projects/Beta', 'Projects/Alpha', 'before'),
      ['Archive', 'INBOX', 'Projects', 'Projects/Beta', 'Projects/Alpha'],
    );
  });

  it('rejects self, cross-parent, missing-path, and invalid-position moves', () => {
    assert.equal(reorderFolderPaths(folders, [], 'INBOX', 'INBOX', 'before'), null);
    assert.equal(
      reorderFolderPaths(folders, [], 'Projects/Alpha', 'Archive', 'before'),
      null,
    );
    assert.equal(reorderFolderPaths(folders, [], 'Gone', 'INBOX', 'before'), null);
    assert.equal(reorderFolderPaths(folders, [], 'INBOX', 'Archive', 'middle'), null);
  });

  it('selects a before or after drop edge from the row midpoint', () => {
    assert.equal(folderDropPosition(110, { top: 100, height: 40 }), 'before');
    assert.equal(folderDropPosition(130, { top: 100, height: 40 }), 'after');
  });

  it('does not persist a drop that leaves the normalized order unchanged', () => {
    assert.equal(
      reorderFolderPaths(folders, [], 'Archive', 'INBOX', 'before'),
      null,
    );
  });

  it('resolves an immediate typed drop from transfer data and the drop event edge', () => {
    const dataTransfer = {
      types: [FOLDER_ORDER_DRAG_TYPE],
      getData: type => type === FOLDER_ORDER_DRAG_TYPE
        ? JSON.stringify({ accountId: 42, path: 'Archive' })
        : '',
    };

    assert.deepEqual(
      resolveFolderOrderDrop(
        folders,
        [],
        dataTransfer,
        42,
        'Projects',
        130,
        { top: 100, height: 40 },
      ),
      ['INBOX', 'Projects', 'Archive', 'Projects/Alpha', 'Projects/Beta'],
    );
  });

  it('rejects cross-parent folder drops and routes message transfers elsewhere', () => {
    const folderTransfer = {
      types: [FOLDER_ORDER_DRAG_TYPE],
      getData: () => JSON.stringify({
        accountId: 42,
        path: 'Projects/Alpha',
      }),
    };
    const messageTransfer = {
      types: ['application/x-mailflow-message'],
      getData: () => JSON.stringify({ messageId: 'message-1' }),
    };

    assert.equal(
      resolveFolderOrderDrop(
        folders,
        [],
        folderTransfer,
        42,
        'Archive',
        110,
        { top: 100, height: 40 },
      ),
      null,
    );
    assert.equal(
      resolveFolderOrderDrop(
        folders,
        [],
        messageTransfer,
        42,
        'INBOX',
        110,
        { top: 100, height: 40 },
      ),
      null,
    );
  });
});
