// Each layout defines the structural arrangement of the three-pane mail UI.
// labelKey / descriptionKey are the i18n keys the UI renders; label and
// description stay as the English fallback for any caller without a translate
// function (and for i18next's own fallback path).
// direction: 'row' = list beside reading pane; 'column' = list above reading pane
// listWidth: px width of the message list in row mode (null for column mode)
// rowPy / rowPx: vertical / horizontal padding inside each message row

export const LAYOUTS = {
  focused: {
    labelKey: 'messageList.layouts.focused.label',
    label: 'Focused',
    descriptionKey: 'messageList.layouts.focused.description',
    description: 'Minimal list panel, maximum reading area',
    direction: 'row',
    listWidth: 210,
    rowPy: 8,
    rowPx: 10,
  },

  compact: {
    labelKey: 'messageList.layouts.compact.label',
    label: 'Compact',
    descriptionKey: 'messageList.layouts.compact.description',
    description: 'Dense rows — fit more messages at once',
    direction: 'row',
    listWidth: 300,
    rowPy: 7,
    rowPx: 12,
  },

  comfortable: {
    labelKey: 'messageList.layouts.comfortable.label',
    label: 'Comfortable',
    descriptionKey: 'messageList.layouts.comfortable.description',
    description: 'Spacious rows with generous padding for easy scanning',
    direction: 'row',
    listWidth: 360,
    rowPy: 16,
    rowPx: 16,
  },

  wide: {
    labelKey: 'messageList.layouts.wide.label',
    label: 'Wide',
    descriptionKey: 'messageList.layouts.wide.description',
    description: 'Broad list shows longer subjects and previews',
    direction: 'row',
    listWidth: 560,
    rowPy: 13,
    rowPx: 16,
  },

  vertical: {
    labelKey: 'messageList.layouts.vertical.label',
    label: 'Vertical Split',
    descriptionKey: 'messageList.layouts.vertical.description',
    description: 'Message list stacked above the reading pane',
    direction: 'column',
    listWidth: null,
    rowPy: 9,
    rowPx: 14,
  },
};

export const DEFAULT_LAYOUT = 'comfortable';

// Coerce a layout key to a known preset, falling back to the default. Guards
// against stale or removed presets persisted in localStorage or synced from the
// server — an unknown key (e.g. an old "classic" preset) must never reach a
// consumer, since it used to crash the message list (#207).
export function normalizeLayout(layoutKey) {
  return layoutKey && LAYOUTS[layoutKey] ? layoutKey : DEFAULT_LAYOUT;
}

// customListWidth: optional px override from drag-to-resize (persisted in localStorage).
// When provided it is applied instead of the preset listWidth.
export function applyLayout(layoutKey, customListWidth) {
  const layout = LAYOUTS[normalizeLayout(layoutKey)];
  const root = document.documentElement;
  root.style.setProperty('--layout-row-py', layout.rowPy + 'px');
  root.style.setProperty('--layout-row-px', layout.rowPx + 'px');
  if (layout.listWidth != null) {
    root.style.setProperty('--list-width', (customListWidth ?? layout.listWidth) + 'px');
  }
}
