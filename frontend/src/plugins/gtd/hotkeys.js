import { buildGtdDisplaySections, resolveRowDisplay } from '../../utils/gtd.js';

let lastRailSelection = null;

export function rememberGtdRailSelection(message, sectionKey) {
  lastRailSelection = { id: message.id, messageId: message.message_id, sectionKey };
}

export function getGtdRailSelection() {
  return lastRailSelection;
}

export function resolveGtdHotkeyTarget(state, railSelection = lastRailSelection) {
  const id = state?.selectedMessageId;
  if (id == null || !state.enabledPlugins?.includes('gtd')) return null;
  const sections = buildGtdDisplaySections(state.gtdSections);
  const selectedCopy = Object.values(state.threadMessages || {}).flat().find(message => message.id === id);
  const sectionFor = key => sections.find(section => section.key === key);
  const fromSection = key => {
    const row = sectionFor(key)?.threads.find(message => message.id === id || (
      selectedCopy?.message_id && message.message_id === selectedCopy.message_id
      && (railSelection?.id === message.id || railSelection?.messageId === message.message_id || state.activeGtdTab === key)
    ));
    if (!row) return null;
    const states = key === 'waiting' ? resolveRowDisplay(row, key).kinds : [key];
    return { message: selectedCopy && selectedCopy.message_id === row.message_id ? { ...row, id: selectedCopy.id } : row, surface: 'rail', states };
  };

  const rail = (state.activeGtdTab && fromSection(state.activeGtdTab))
    || ((railSelection?.id === id || (selectedCopy?.message_id && railSelection?.messageId === selectedCopy.message_id)) && fromSection(railSelection.sectionKey));
  const pool = state.searchQuery?.trim() ? state.searchResults : state.messages;
  const main = pool?.find(message => message.id === id);
  const target = rail || (main ? { message: main, surface: 'main', states: null } : sections.map(section => fromSection(section.key)).find(Boolean));
  if (!target || !state.accounts?.find(account => account.id === target.message.account_id)?.gtd_enabled) return null;
  return target;
}

const CLASSIFICATION_ACTIONS = {
  gtdTodo: 'todo', gtdWatch: 'watch', gtdDelegated: 'delegated',
  gtdReference: 'reference', gtdSomeday: 'someday',
};

export async function runGtdHotkey(action, state, { classify, doneMain, doneRail }, railSelection = lastRailSelection) {
  const target = resolveGtdHotkeyTarget(state, railSelection);
  if (!target) return false;
  if (action === 'gtdDone') {
    if (target.surface === 'rail') await doneRail(target.message, target.states);
    else await doneMain(target.message);
    return true;
  }
  const kind = CLASSIFICATION_ACTIONS[action];
  if (!kind) return false;
  await classify(target.message.id, kind);
  return true;
}
