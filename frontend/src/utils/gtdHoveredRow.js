// The row under the pointer can receive a small set of global shortcuts without
// changing the selected-message target used by the rest of the app.
let hoveredRow = null;

export function registerHoveredGtdRow(actions) {
  const token = Symbol('hovered-gtd-row');
  hoveredRow = { token, actions };
  return token;
}

export function clearHoveredGtdRow(token) {
  if (!hoveredRow || hoveredRow.token !== token) return false;
  hoveredRow = null;
  return true;
}

export function dispatchHoveredGtdShortcut(action) {
  if (!hoveredRow) return false;

  if (action === 'gtdTodo') {
    if (typeof hoveredRow.actions.classify !== 'function') return false;
    hoveredRow.actions.classify('todo');
    return true;
  }
  if (action === 'gtdWatch') {
    if (typeof hoveredRow.actions.classify !== 'function') return false;
    hoveredRow.actions.classify('watch');
    return true;
  }
  if (action === 'archive') {
    if (typeof hoveredRow.actions.archive !== 'function') return false;
    hoveredRow.actions.archive();
    return true;
  }

  return false;
}
