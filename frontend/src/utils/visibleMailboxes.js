// The sidebar marks each rendered, selectable row. Reading those same nodes
// preserves its actual order, including favorites and expanded folder trees.
export function visibleMailboxRows(root) {
  return [...(root?.querySelectorAll('[data-mailbox-row]') || [])]
    .filter(row => row.dataset.mailboxAvailable !== 'false');
}

export function navigateVisibleMailbox(root, number) {
  if (!Number.isInteger(number) || number < 1 || number > 9) return false;
  const row = visibleMailboxRows(root)[number - 1];
  if (!row) return false;
  row.click();
  return true;
}

export function canRunMailboxShortcut(action, root) {
  if (action === 'toggleLeftSidebar') return true;
  const match = /^goVisibleMailbox([1-9])$/.exec(action);
  return match ? Boolean(visibleMailboxRows(root)[Number(match[1]) - 1]) : false;
}

export function browserShortcutFallback(sequence) {
  if (sequence === 'gl') return 'openLabelPicker';
  const match = /^g([1-9])$/.exec(sequence);
  if (!match) return null;
  return `goVisibleMailbox${match[1]}`;
}

export function runMailboxShortcut(action, store, root) {
  if (action === 'toggleLeftSidebar') {
    store.toggleSidebar();
    return true;
  }
  const match = /^goVisibleMailbox([1-9])$/.exec(action);
  return match ? navigateVisibleMailbox(root, Number(match[1])) : false;
}
