// Render-level checks for the GTD rail row. The hover color should use the same theme token as
// inbox rows, and pointer hover remains available independently of the optional hover buttons.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';
import { transform } from 'sucrase';

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('react-i18next/dist/es/index.js') || url.endsWith('/react-i18next')) {
      return { format: 'module', shortCircuit: true, source: [
        'export const useTranslation = () => ({ t: (k, d) => (typeof d === "string" ? d : k), i18n: { language: "en", changeLanguage: () => {} } });',
        'export const initReactI18next = { type: "3rdParty", init: () => {} };',
        'export const Trans = ({ children }) => children ?? null;',
        'export const I18nextProvider = ({ children }) => children ?? null;',
        'export default { useTranslation, initReactI18next };',
      ].join('\n') };
    }
    if (url.endsWith('.json')) {
      return { format: 'module', shortCircuit: true, source: `export default ${readFileSync(new URL(url), 'utf8')}` };
    }
    if (url.endsWith('.jsx')) {
      const code = readFileSync(new URL(url), 'utf8');
      const out = transform(code, { transforms: ['jsx'], jsxRuntime: 'automatic', filePath: url });
      return { format: 'module', shortCircuit: true, source: out.code };
    }
    return nextLoad(url, context);
  },
});

const dom = new JSDOM('<div id="root"></div>', { url: 'https://mail.example.invalid', pretendToBeVisual: true });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  localStorage: dom.window.localStorage,
  HTMLElement: dom.window.HTMLElement,
  Node: dom.window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
});

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const {
  dispatchHoveredGtdShortcut,
} = await import('../utils/gtdHoveredRow.js');
const GtdEntryRow = (await import('./GtdEntryRow.jsx')).default;
const GtdTriageRow = (await import('./GtdTriageRow.jsx')).default;

const ROW = {
  id: 'gtd-row-1', message_id: '<gtd-1@example.invalid>', account_id: 'account-1',
  from_name: 'Sender', subject: 'A GTD message', snippet: 'A short preview',
  date: '2026-09-24T12:00:00.000Z', is_read: false, is_starred: false,
};
const STATE = {
  enabledPlugins: ['gtd'], accounts: [{ id: 'account-1', gtd_enabled: true }],
  gtdSections: { todo: { threads: [ROW] } }, messages: [], threadMessages: {},
};

test('GTD sidebar row hover matches the inbox row hover color', async () => {
  const container = document.getElementById('root');
  const root = createRoot(container);
  await React.act(async () => {
    root.render(React.createElement(GtdEntryRow, {
      thread: ROW,
      sectionKey: 'todo',
      variant: 'sidebar',
      selected: false,
      t: key => key,
      onClick: () => {},
      onContextMenu: () => {},
    }));
  });

  const row = container.firstElementChild;
  try {
    assert.equal(row.style.background, 'transparent');
    await React.act(async () => {
      row.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }));
    });

    // MessageList uses --bg-tertiary for the inbox row hover state.
    assert.equal(row.style.background, 'var(--bg-tertiary)');

    await React.act(async () => {
      row.dispatchEvent(new dom.window.MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
    });
    assert.equal(row.style.background, 'transparent');
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('GTD browse-list row keeps its existing hover color', async () => {
  const container = document.getElementById('root');
  const root = createRoot(container);
  await React.act(async () => {
    root.render(React.createElement(GtdEntryRow, {
      thread: ROW,
      sectionKey: 'todo',
      variant: 'list',
      selected: false,
      t: key => key,
      onClick: () => {},
      onContextMenu: () => {},
    }));
  });

  const row = container.firstElementChild;
  try {
    await React.act(async () => {
      row.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }));
    });
    assert.equal(row.style.background, 'var(--bg-hover)');
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('sidebar hover routes Todo, Watch, and archive shortcuts to that row without hover buttons', async () => {
  const calls = [];
  const container = document.getElementById('root');
  const root = createRoot(container);
  await React.act(async () => {
    root.render(React.createElement(GtdTriageRow, {
      thread: ROW,
      sectionKey: 'todo',
      variant: 'sidebar',
      selected: false,
      t: key => key,
      onClick: () => {},
      onOpen: () => {},
      rowActions: {
        classifyRow: (thread, state) => calls.push(['classify', thread.id, state]),
        done: (thread, states) => calls.push(['done', thread.id, states]),
        openMenu: () => {},
      },
      hoverQuickActions: false,
    }));
  });

  const row = container.firstElementChild;
  try {
    await React.act(async () => {
      row.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }));
    });
    assert.equal(dispatchHoveredGtdShortcut('gtdTodo', STATE), true);
    assert.equal(dispatchHoveredGtdShortcut('gtdWatch', STATE), true);
    assert.equal(dispatchHoveredGtdShortcut('archive', STATE), true);
    assert.deepEqual(calls, [
      ['classify', ROW.id, 'todo'],
      ['classify', ROW.id, 'watch'],
      ['done', ROW.id, ['todo']],
    ]);

    await React.act(async () => {
      row.dispatchEvent(new dom.window.MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
    });
    assert.equal(dispatchHoveredGtdShortcut('gtdTodo', STATE), false);
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('selected sidebar row keeps its selected fill while hovered', async () => {
  const container = document.getElementById('root');
  const root = createRoot(container);
  await React.act(async () => {
    root.render(React.createElement(GtdEntryRow, {
      thread: ROW,
      sectionKey: 'todo',
      variant: 'sidebar',
      selected: true,
      t: key => key,
      onClick: () => {},
      onContextMenu: () => {},
    }));
  });

  const row = container.firstElementChild;
  try {
    await React.act(async () => {
      row.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }));
    });
    assert.equal(row.style.background, 'var(--bg-tertiary)');
    await React.act(async () => {
      row.dispatchEvent(new dom.window.MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
    });
    assert.equal(row.style.background, 'var(--bg-tertiary)');
  } finally {
    await React.act(async () => root.unmount());
  }
});

test('unmounting a hovered sidebar row restores normal shortcut routing', async () => {
  const root = createRoot(document.getElementById('root'));
  await React.act(async () => root.render(React.createElement(GtdTriageRow, {
    thread: ROW, sectionKey: 'todo', variant: 'sidebar', selected: false,
    t: key => key, onOpen: () => {}, hoverQuickActions: false,
    rowActions: { classifyRow() {}, done() {}, openMenu() {} },
  })));
  const row = document.getElementById('root').firstElementChild;
  await React.act(async () => row.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true })));
  await React.act(async () => root.unmount());
  assert.equal(dispatchHoveredGtdShortcut('gtdTodo', STATE), false);
});

test('reusing a hovered component for another row clears the previous pointer target', async () => {
  const root = createRoot(document.getElementById('root'));
  const props = {
    thread: ROW, sectionKey: 'todo', variant: 'sidebar', selected: false,
    t: key => key, onOpen: () => {}, hoverQuickActions: false,
    rowActions: { classifyRow() {}, done() {}, openMenu() {} },
  };
  try {
    await React.act(async () => root.render(React.createElement(GtdTriageRow, props)));
    const row = document.getElementById('root').firstElementChild;
    await React.act(async () => row.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true })));
    await React.act(async () => root.render(React.createElement(GtdTriageRow, {
      ...props, thread: { ...ROW, id: 'replacement-row' },
    })));
    assert.equal(dispatchHoveredGtdShortcut('gtdTodo', STATE), false);
  } finally { await React.act(async () => root.unmount()); }
});

test('hovered row classification uses real triage Undo and preserves unrelated Undo on switches', async () => {
  const { useGtdTriage } = await import('../hooks/useGtdTriage.js');
  const { useStore } = await import('../store/index.js');
  const { api } = await import('../utils/api.js');
  const savedState = useStore.getState();
  const savedClassify = api.gtdClassify;
  const savedUndo = api.gtdUndoClassify;
  const calls = [];
  const undoToken = { messageId: ROW.id, state: 'watch', folder: 'Watch', uid: 123 };
  let switched = false;
  let undone = false;
  api.gtdClassify = async (id, state) => {
    calls.push([id, state]);
    return switched ? { switched: true } : { applied: true, undoToken };
  };
  api.gtdUndoClassify = async token => { assert.deepEqual(token, undoToken); undone = true; };
  useStore.setState({
    ...STATE, selectedMessageId: 'selected-elsewhere', notifications: [], scheduleGtdSectionsFetch() {},
  });
  function RealTriageRow() {
    const { rowActions } = useGtdTriage();
    return React.createElement(GtdTriageRow, {
      thread: ROW, sectionKey: 'todo', variant: 'sidebar', selected: false,
      t: key => key, onOpen() {}, hoverQuickActions: false, rowActions,
    });
  }
  const root = createRoot(document.getElementById('root'));
  try {
    await React.act(async () => root.render(React.createElement(RealTriageRow)));
    const row = document.getElementById('root').firstElementChild;
    await React.act(async () => row.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true })));
    await React.act(async () => { assert.equal(dispatchHoveredGtdShortcut('gtdWatch', useStore.getState()), true); });
    const firstUndo = useStore.getState().notifications[0];
    assert.equal(typeof firstUndo.onUndo, 'function');
    assert.equal(firstUndo.gtdUndoScope.accountId, ROW.account_id);
    await firstUndo.onUndo();
    assert.equal(undone, true);
    await React.act(async () => { dispatchHoveredGtdShortcut('gtdTodo', useStore.getState()); });
    const threadUndo = useStore.getState().notifications[0];
    let deleteUndone = false;
    useStore.getState().addNotification({ title: 'Deleted B', onUndo: () => { deleteUndone = true; } });
    const deleteUndo = useStore.getState().notifications[0];
    switched = true;
    await React.act(async () => { dispatchHoveredGtdShortcut('gtdWatch', useStore.getState()); });
    assert.equal(useStore.getState().notifications.some(n => n.id === threadUndo.id), false);
    assert.equal(useStore.getState().notifications.some(n => n.id === deleteUndo.id), true);
    await deleteUndo.onUndo();
    assert.equal(deleteUndone, true);
    assert.equal(useStore.getState().selectedMessageId, 'selected-elsewhere');
    assert.deepEqual(calls, [[ROW.id, 'watch'], [ROW.id, 'todo'], [ROW.id, 'watch']]);
  } finally {
    await React.act(async () => root.unmount());
    useStore.setState(savedState);
    api.gtdClassify = savedClassify;
    api.gtdUndoClassify = savedUndo;
  }
});
