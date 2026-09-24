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
    assert.equal(dispatchHoveredGtdShortcut('gtdTodo'), true);
    assert.equal(dispatchHoveredGtdShortcut('gtdWatch'), true);
    assert.equal(dispatchHoveredGtdShortcut('archive'), true);
    assert.deepEqual(calls, [
      ['classify', ROW.id, 'todo'],
      ['classify', ROW.id, 'watch'],
      ['done', ROW.id, ['todo']],
    ]);

    await React.act(async () => {
      row.dispatchEvent(new dom.window.MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
    });
    assert.equal(dispatchHoveredGtdShortcut('gtdTodo'), false);
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
