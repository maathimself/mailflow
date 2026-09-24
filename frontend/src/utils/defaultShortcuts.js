// Keyboard shortcut action definitions and helpers.
//
// Each action carries i18n key paths (groupKey / labelKey / descriptionKey) for
// its display strings plus a defaultKey. The key paths are resolved with t() at
// render time, so this module stays framework-free (no i18n import here).
// defaultKey can be a multi-character string (e.g. 'gi') for two-key sequences.
//
// User overrides are stored as { actionName: key } in preferences and merged
// over defaults at runtime — override keys win; unoverridden actions use defaults.

// Keys whose e.key value is longer than one character but represent a single
// keypress (not a two-key sequence). Used to distinguish "Delete" from "gi".
export const SPECIAL_KEY_LABELS = {
  Delete: 'Del', Backspace: '⌫', Enter: '↵', Tab: 'Tab',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  Home: 'Home', End: 'End', PageUp: 'PgUp', PageDown: 'PgDn', Insert: 'Ins',
  F1: 'F1', F2: 'F2', F3: 'F3', F4: 'F4', F5: 'F5', F6: 'F6',
  F7: 'F7', F8: 'F8', F9: 'F9', F10: 'F10', F11: 'F11', F12: 'F12',
};
export const SPECIAL_KEYS = new Set(Object.keys(SPECIAL_KEY_LABELS));

export const ACTION_DEFS = {
  // ── Compose & search ───────────────────────────────────────────────────────
  compose:       { groupKey: 'shortcuts.groups.composeSearch',  labelKey: 'shortcuts.actions.compose.label',       descriptionKey: 'shortcuts.actions.compose.description',       defaultKey: 'c'  },
  focusSearch:   { groupKey: 'shortcuts.groups.composeSearch',  labelKey: 'shortcuts.actions.focusSearch.label',   descriptionKey: 'shortcuts.actions.focusSearch.description',   defaultKey: '/'  },
  showHelp:      { groupKey: 'shortcuts.groups.composeSearch',  labelKey: 'shortcuts.actions.showHelp.label',      descriptionKey: 'shortcuts.actions.showHelp.description',      defaultKey: '?'  },

  // ── Navigation ─────────────────────────────────────────────────────────────
  nextMessage:   { groupKey: 'shortcuts.groups.navigation',     labelKey: 'shortcuts.actions.nextMessage.label',   descriptionKey: 'shortcuts.actions.nextMessage.description',   defaultKey: 'j'  },
  prevMessage:   { groupKey: 'shortcuts.groups.navigation',     labelKey: 'shortcuts.actions.prevMessage.label',   descriptionKey: 'shortcuts.actions.prevMessage.description',   defaultKey: 'k'  },
  openMessage:   { groupKey: 'shortcuts.groups.navigation',     labelKey: 'shortcuts.actions.openMessage.label',   descriptionKey: 'shortcuts.actions.openMessage.description',   defaultKey: 'o'  },
  goInbox:       { groupKey: 'shortcuts.groups.navigation',     labelKey: 'shortcuts.actions.goInbox.label',       descriptionKey: 'shortcuts.actions.goInbox.description',       defaultKey: 'gi' },
  toggleLeftSidebar: { groupKey: 'shortcuts.groups.navigation', labelKey: 'shortcuts.actions.toggleLeftSidebar.label', descriptionKey: 'shortcuts.actions.toggleLeftSidebar.description', defaultKey: 'ctrl+\\' },
  ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => {
    const n = i + 1;
    const action = `goVisibleMailbox${n}`;
    return [action, { groupKey: 'shortcuts.groups.navigation', labelKey: `shortcuts.actions.${action}.label`, descriptionKey: `shortcuts.actions.${action}.description`, defaultKey: `ctrl+${n}` }];
  })),
  openLabelPicker: { groupKey: 'shortcuts.groups.navigation', labelKey: 'shortcuts.actions.openLabelPicker.label', descriptionKey: 'shortcuts.actions.openLabelPicker.description', defaultKey: 'ctrl+l' },
  toggleRightSidebar: { groupKey: 'shortcuts.groups.navigation', labelKey: 'shortcuts.actions.toggleRightSidebar.label', descriptionKey: 'shortcuts.actions.toggleRightSidebar.description', defaultKey: 'ctrl+/' },

  // ── Message actions ────────────────────────────────────────────────────────
  reply:         { groupKey: 'shortcuts.groups.messageActions', labelKey: 'shortcuts.actions.reply.label',         descriptionKey: 'shortcuts.actions.reply.description',         defaultKey: 'r'  },
  replyAll:      { groupKey: 'shortcuts.groups.messageActions', labelKey: 'shortcuts.actions.replyAll.label',      descriptionKey: 'shortcuts.actions.replyAll.description',      defaultKey: 'a'  },
  forward:       { groupKey: 'shortcuts.groups.messageActions', labelKey: 'shortcuts.actions.forward.label',       descriptionKey: 'shortcuts.actions.forward.description',       defaultKey: 'f'  },
  replyAllFromSelection: { groupKey: 'shortcuts.groups.messageActions', labelKey: 'shortcuts.actions.replyAllFromSelection.label', descriptionKey: 'shortcuts.actions.replyAllFromSelection.description', defaultKey: 'ctrl+Enter' },
  markUnread: { groupKey: 'shortcuts.groups.messageActions', labelKey: 'shortcuts.actions.markUnread.label', descriptionKey: 'shortcuts.actions.markUnread.description', defaultKey: 'u' },
  unsubscribe: { groupKey: 'shortcuts.groups.messageActions', labelKey: 'shortcuts.actions.unsubscribe.label', descriptionKey: 'shortcuts.actions.unsubscribe.description', defaultKey: 'ctrl+shift+u' },
  loadRemoteImages: { groupKey: 'shortcuts.groups.messageActions', labelKey: 'shortcuts.actions.loadRemoteImages.label', descriptionKey: 'shortcuts.actions.loadRemoteImages.description', defaultKey: 'i' },
  archive:       { groupKey: 'shortcuts.groups.messageActions', labelKey: 'shortcuts.actions.archive.label',       descriptionKey: 'shortcuts.actions.archive.description',       defaultKey: 'e'  },
  delete:        { groupKey: 'shortcuts.groups.messageActions', labelKey: 'shortcuts.actions.delete.label',        descriptionKey: 'shortcuts.actions.delete.description',        defaultKey: '#'  },
  toggleStar:    { groupKey: 'shortcuts.groups.messageActions', labelKey: 'shortcuts.actions.toggleStar.label',    descriptionKey: 'shortcuts.actions.toggleStar.description',    defaultKey: 's'  },
  toggleRead:    { groupKey: 'shortcuts.groups.messageActions', labelKey: 'shortcuts.actions.toggleRead.label',    descriptionKey: 'shortcuts.actions.toggleRead.description',    defaultKey: 'm'  },
  selectMessage: { groupKey: 'shortcuts.groups.messageActions', labelKey: 'shortcuts.actions.selectMessage.label', descriptionKey: 'shortcuts.actions.selectMessage.description', defaultKey: 'x'      },
  printMessage:  { groupKey: 'shortcuts.groups.messageActions', labelKey: 'shortcuts.actions.printMessage.label',  descriptionKey: 'shortcuts.actions.printMessage.description',  defaultKey: 'ctrl+p' },

  // ── GTD ──────────────────────────────────────────────────────────────────────
  // Classify the selected message into a GTD state (COPY into its label folder).
  // Someday/Reference are intentionally keyless (context menu + user-bindable).
  gtdTodo:       { groupKey: 'shortcuts.groups.gtd',            labelKey: 'shortcuts.actions.gtdTodo.label',       descriptionKey: 'shortcuts.actions.gtdTodo.description',       defaultKey: 't' },
  gtdWatch:      { groupKey: 'shortcuts.groups.gtd',            labelKey: 'shortcuts.actions.gtdWatch.label',      descriptionKey: 'shortcuts.actions.gtdWatch.description',      defaultKey: 'w' },
  gtdDelegated:  { groupKey: 'shortcuts.groups.gtd',            labelKey: 'shortcuts.actions.gtdDelegated.label',  descriptionKey: 'shortcuts.actions.gtdDelegated.description',  defaultKey: 'd' },
  gtdUndo:       { groupKey: 'shortcuts.groups.gtd',            labelKey: 'common.undo',                            descriptionKey: 'shortcuts.actions.gtdUndo.description',       defaultKey: 'ctrl+z' },
};

// Returns the effective shortcut map: action → key, with user overrides applied.
export function getEffectiveShortcuts(userOverrides = {}) {
  const out = {};
  for (const [action, def] of Object.entries(ACTION_DEFS)) {
    out[action] = action in userOverrides ? userOverrides[action] : def.defaultKey;
  }
  return out;
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform);

// Full modifier label for help overlay / settings (e.g. '⌘' or 'Ctrl')
export function modLabel(mod) {
  if (mod === 'ctrl') return isMac ? '⌘' : 'Ctrl';
  return mod;
}

// Compact modifier label for toolbar badges (e.g. '⌘' or '^')
export function modCompactLabel(mod) {
  if (mod === 'ctrl') return isMac ? '⌘' : '^';
  return mod;
}

// Parses a modifier+key string. Returns { mod, bare } or null for plain keys.
// e.g. parseModKey('ctrl+p') → { mod: 'ctrl', bare: 'p' }
export function parseModKey(key) {
  if (!key) return null;
  const plus = key.indexOf('+');
  if (plus < 0) return null;
  return { mod: key.slice(0, plus), bare: key.slice(plus + 1) };
}

// Returns the reverse lookup map: key → action, for fast dispatch (plain keys only).
// Collisions (two actions resolving to the same key, e.g. via user overrides)
// keep last-writer-wins behavior but are logged so they're not silently lost.
export function buildKeyMap(userOverrides = {}) {
  const effective = getEffectiveShortcuts(userOverrides);
  const map = {};
  for (const [action, key] of Object.entries(effective)) {
    if (!key || parseModKey(key)) continue;
    if (map[key]) {
      console.warn(`[shortcuts] key "${key}" is bound to both "${map[key]}" and "${action}"; "${action}" wins`);
    }
    map[key] = action;
  }
  return map;
}

// Returns a reverse lookup for modifier+key shortcuts: bare key → action.
// e.g. { p: 'printMessage' } when printMessage is bound to 'ctrl+p'.
// Collisions are logged the same way as buildKeyMap (see above).
export function buildModKeyMap(userOverrides = {}) {
  const effective = getEffectiveShortcuts(userOverrides);
  const map = {};
  for (const [action, key] of Object.entries(effective)) {
    const parsed = parseModKey(key);
    if (!parsed) continue;
    const bare = parsed.bare.toLowerCase();
    if (map[bare]) {
      console.warn(`[shortcuts] key "${bare}" is bound to both "${map[bare]}" and "${action}"; "${action}" wins`);
    }
    map[bare] = action;
  }
  return map;
}

// Match the full modifier set. A shifted punctuation character already carries
// Shift in event.key on common keyboard layouts.
export function resolveShortcutAction(event, userOverrides = {}) {
  if (!event?.key) return null;
  const key = event.key.toLowerCase();
  const isCommand = isMac ? !!event.metaKey && !event.ctrlKey : !!event.ctrlKey && !event.metaKey;
  if ((event.ctrlKey || event.metaKey) && !isCommand) return null;
  let found = null;
  for (const [action, binding] of Object.entries(getEffectiveShortcuts(userOverrides))) {
    if (!binding) continue;
    const pieces = binding.toLowerCase().split('+');
    const bare = pieces.pop();
    const command = pieces.includes('ctrl');
    const shift = pieces.includes('shift');
    const alt = pieces.includes('alt');
    if (pieces.some(piece => piece !== 'ctrl' && piece !== 'shift' && piece !== 'alt')) continue;
    if (command !== isCommand || alt !== !!event.altKey || bare !== key) continue;
    if (shift !== !!event.shiftKey && key !== '?' && key !== '#') continue;
    if (shift && !event.shiftKey) continue;
    found = action;
  }
  return found;
}

const GENERAL_ACTION_TEXT = {
  toggleLeftSidebar: ['Toggle left sidebar', 'Hide or show the left sidebar'],
  openLabelPicker: ['Open label picker', 'Copy the selected message to a folder'],
  replyAllFromSelection: ['Reply all from selection', 'Reply all to the selected message'],
  markUnread: ['Mark unread', 'Mark the selected message unread'],
  unsubscribe: ['Unsubscribe', 'Unsubscribe from the selected mailing list'],
  loadRemoteImages: ['Load remote images', 'Load images in the selected message'],
};

export function shortcutActionText(t, action, kind = 'description') {
  const definition = ACTION_DEFS[action];
  if (!definition) return '';
  const mailboxNumber = /^goVisibleMailbox([1-9])$/.exec(action)?.[1];
  const label = kind === 'label';
  if (mailboxNumber) {
    return t(`shortcuts.visibleMailbox.${kind}`, {
      number: Number(mailboxNumber),
      defaultValue: label ? 'Visible mailbox {{number}}' : 'Open visible mailbox {{number}}',
    });
  }
  const fallback = GENERAL_ACTION_TEXT[action];
  return t(label ? definition.labelKey : definition.descriptionKey,
    fallback ? { defaultValue: fallback[label ? 0 : 1] } : undefined);
}

// Returns actions grouped for display in the help overlay / settings tab.
export function getGroupedActions() {
  const groups = {};
  for (const [action, def] of Object.entries(ACTION_DEFS)) {
    if (!groups[def.groupKey]) groups[def.groupKey] = [];
    groups[def.groupKey].push({ action, ...def });
  }
  return groups;
}
