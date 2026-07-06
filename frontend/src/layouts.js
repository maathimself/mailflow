// Each layout defines the structural arrangement of the three-pane mail UI.
// direction: 'row' = list beside reading pane; 'column' = list above reading pane
// listWidth: px width of the message list in row mode (null for column mode)
// rowPy / rowPx: vertical / horizontal padding inside each message row

export const LAYOUTS = {
  focused: {
    label: 'Focused',
    description: 'Minimal list panel, maximum reading area',
    direction: 'row',
    listWidth: 210,
    rowPy: 8,
    rowPx: 10,
  },

  compact: {
    label: 'Compact',
    description: 'Dense rows — fit more messages at once',
    direction: 'row',
    listWidth: 300,
    rowPy: 7,
    rowPx: 12,
  },

  comfortable: {
    label: 'Comfortable',
    description: 'Spacious rows with generous padding for easy scanning',
    direction: 'row',
    listWidth: 360,
    rowPy: 16,
    rowPx: 16,
  },

  wide: {
    label: 'Wide',
    description: 'Broad list shows longer subjects and previews',
    direction: 'row',
    listWidth: 560,
    rowPy: 13,
    rowPx: 16,
  },

  vertical: {
    label: 'Vertical Split',
    description: 'Message list stacked above the reading pane',
    direction: 'column',
    listWidth: null,
    rowPy: 9,
    rowPx: 14,
  },
};

// customListWidth: optional px override from drag-to-resize (persisted in localStorage).
// When provided it is applied instead of the preset listWidth.
export function applyLayout(layoutKey, customListWidth) {
  const layout = LAYOUTS[layoutKey] || LAYOUTS.comfortable;
  const root = document.documentElement;
  root.style.setProperty('--layout-row-py', layout.rowPy + 'px');
  root.style.setProperty('--layout-row-px', layout.rowPx + 'px');
  if (layout.listWidth != null) {
    root.style.setProperty('--list-width', (customListWidth ?? layout.listWidth) + 'px');
  }
}
