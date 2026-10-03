import { resolveGtdHotkeyTarget, runGtdHotkey } from './gtdHotkeys.js';
import { buildGtdDisplaySections } from './gtd.js';

let hoveredRow = null;
const HOVER_ACTIONS = { gtdTodo: 'gtdTodo', gtdWatch: 'gtdWatch', archive: 'gtdDone' };

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

function resolveHoveredTarget(action, state) {
  const kind = HOVER_ACTIONS[action];
  const actions = hoveredRow?.actions;
  if (!kind || !actions?.message || state?.rightSidebarHidden) return null;
  if (typeof (action === 'archive' ? actions.archive : actions.classify) !== 'function') return null;
  const { message, sectionKey } = actions;
  const section = buildGtdDisplaySections(state?.gtdSections).find(section => section.key === sectionKey);
  if (!section?.threads.some(row => row.id === message.id && row.account_id === message.account_id)) return null;
  const railSelection = { id: message.id, sectionKey };
  const targetedState = { ...state, selectedMessageId: message.id, activeGtdTab: sectionKey };
  const target = resolveGtdHotkeyTarget(targetedState, railSelection);
  if (target?.surface !== 'rail' || target.message.id !== message.id
      || target.message.account_id !== message.account_id) return null;
  return { kind, actions, targetedState, railSelection };
}

export function canDispatchHoveredGtdShortcut(action, state) {
  return Boolean(resolveHoveredTarget(action, state));
}

export function dispatchHoveredGtdShortcut(action, state) {
  const target = resolveHoveredTarget(action, state);
  if (!target) return false;
  const { kind, actions, targetedState, railSelection } = target;
  void runGtdHotkey(kind, targetedState, {
    classify: (_id, state, message) => actions.classify(message, state),
    doneRail: (message, states) => actions.archive(message, states),
  }, railSelection);
  return true;
}
