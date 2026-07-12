// Keyboard shortcut action definitions and helpers.
//
// Each action has a label, description, group (for display), and defaultKey.
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
  compose:       { group: 'Compose & Search', label: 'Compose',            description: 'Open new compose window',               defaultKey: 'c'  },
  focusSearch:   { group: 'Compose & Search', label: 'Search',             description: 'Focus the search box',                  defaultKey: '/'  },
  showHelp:      { group: 'Compose & Search', label: 'Show shortcuts',     description: 'Show this keyboard shortcut reference',  defaultKey: '?'  },

  // ── Navigation ─────────────────────────────────────────────────────────────
  nextMessage:   { group: 'Navigation',       label: 'Next message',       description: 'Move to the next message',               defaultKey: 'j'  },
  prevMessage:   { group: 'Navigation',       label: 'Previous message',   description: 'Move to the previous message',           defaultKey: 'k'  },
  openMessage:   { group: 'Navigation',       label: 'Open first message', description: 'Open first message if none selected',    defaultKey: 'o'  },
  goInbox:       { group: 'Navigation',       label: 'Go to Inbox',        description: 'Navigate to the unified inbox',          defaultKey: 'gi' },

  // ── Message actions ────────────────────────────────────────────────────────
  reply:         { group: 'Message Actions',  label: 'Reply',              description: 'Reply to the current message',           defaultKey: 'r'  },
  replyAll:      { group: 'Message Actions',  label: 'Reply all',          description: 'Reply all to the current message',       defaultKey: 'a'  },
  forward:       { group: 'Message Actions',  label: 'Forward',            description: 'Forward the current message',            defaultKey: 'f'  },
  archive:       { group: 'Message Actions',  label: 'Archive',            description: 'Archive message / selection',            defaultKey: 'e'  },
  delete:        { group: 'Message Actions',  label: 'Delete',             description: 'Delete message / selection',             defaultKey: '#'  },
  toggleStar:    { group: 'Message Actions',  label: 'Star',               description: 'Toggle star on the current message',     defaultKey: 's'  },
  toggleRead:    { group: 'Message Actions',  label: 'Toggle read',        description: 'Mark current message read or unread',    defaultKey: 'm'  },
  selectMessage: { group: 'Message Actions',  label: 'Select message',     description: 'Check or uncheck the current message',   defaultKey: 'x'      },
  printMessage:  { group: 'Message Actions',  label: 'Print',              description: 'Print the current message',               defaultKey: 'ctrl+p' },
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
    if (!groups[def.group]) groups[def.group] = [];
    groups[def.group].push({ action, ...def });
  }
  return groups;
}
