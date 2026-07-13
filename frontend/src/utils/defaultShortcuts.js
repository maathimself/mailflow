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
  toggleRightSidebar: { groupKey: 'shortcuts.groups.navigation', labelKey: 'shortcuts.actions.toggleRightSidebar.label', descriptionKey: 'shortcuts.actions.toggleRightSidebar.description', defaultKey: 'ctrl+/' },

  // ── Message actions ────────────────────────────────────────────────────────
  reply:         { groupKey: 'shortcuts.groups.messageActions', labelKey: 'shortcuts.actions.reply.label',         descriptionKey: 'shortcuts.actions.reply.description',         defaultKey: 'r'  },
  replyAll:      { groupKey: 'shortcuts.groups.messageActions', labelKey: 'shortcuts.actions.replyAll.label',      descriptionKey: 'shortcuts.actions.replyAll.description',      defaultKey: 'a'  },
  forward:       { groupKey: 'shortcuts.groups.messageActions', labelKey: 'shortcuts.actions.forward.label',       descriptionKey: 'shortcuts.actions.forward.description',       defaultKey: 'f'  },
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
    if (map[parsed.bare]) {
      console.warn(`[shortcuts] key "${parsed.bare}" is bound to both "${map[parsed.bare]}" and "${action}"; "${action}" wins`);
    }
    map[parsed.bare] = action;
  }
  return map;
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
