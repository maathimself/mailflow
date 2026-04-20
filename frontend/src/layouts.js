// Each layout defines the structural arrangement of the three-pane mail UI.
// direction: 'row' = list beside reading pane; 'column' = list above reading pane
// listWidth: px width of the message list in row mode (null for column mode)
// rowPy / rowPx: vertical / horizontal padding inside each message row

export const LAYOUTS = {
  classic: {
    label: 'Classic',
    description: 'Sidebar, message list, and reading pane side by side',
    direction: 'row',
    listWidth: 340,
    rowPy: 11,
    rowPx: 14,
  },

  compact: {
    label: 'Compact',
    description: 'Dense rows — fit more messages in the list at once',
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

  wide_reader: {
    label: 'Wide Reader',
    description: 'Narrow message list gives maximum reading pane width',
    direction: 'row',
    listWidth: 240,
    rowPy: 9,
    rowPx: 12,
  },

  wide_list: {
    label: 'Wide List',
    description: 'Broader message list shows longer subjects and previews',
    direction: 'row',
    listWidth: 460,
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

  focused: {
    label: 'Focused',
    description: 'Minimal list panel, maximum reading area for distraction-free reading',
    direction: 'row',
    listWidth: 210,
    rowPy: 8,
    rowPx: 10,
  },
};

export function applyLayout(layoutKey) {
  const layout = LAYOUTS[layoutKey] || LAYOUTS.classic;
  const root = document.documentElement;
  root.style.setProperty('--layout-row-py', layout.rowPy + 'px');
  root.style.setProperty('--layout-row-px', layout.rowPx + 'px');
}
