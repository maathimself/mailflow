// Keyboard shortcut action definitions and helpers.
//
// Each action has a label, description, group (for display), and defaultKey.
// defaultKey can be a multi-character string (e.g. 'gi') for two-key sequences.
//
// User overrides are stored as { actionName: key } in preferences and merged
// over defaults at runtime — override keys win; unoverridden actions use defaults.

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
  selectMessage: { group: 'Message Actions',  label: 'Select message',     description: 'Check or uncheck the current message',   defaultKey: 'x'  },
};

// Returns the effective shortcut map: action → key, with user overrides applied.
export function getEffectiveShortcuts(userOverrides = {}) {
  const out = {};
  for (const [action, def] of Object.entries(ACTION_DEFS)) {
    out[action] = action in userOverrides ? userOverrides[action] : def.defaultKey;
  }
  return out;
}

// Returns the reverse lookup map: key → action, for fast dispatch.
export function buildKeyMap(userOverrides = {}) {
  const effective = getEffectiveShortcuts(userOverrides);
  const map = {};
  for (const [action, key] of Object.entries(effective)) {
    if (key) map[key] = action;
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
