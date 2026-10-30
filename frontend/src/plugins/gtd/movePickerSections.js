import { resolveAccountGtdFolders } from '../../utils/gtd.js';

// GTD's contribution to core's 'move-picker-sections' collector: one item per state, tagging the
// picked messages (a COPY into the state's label folder, not a move). Core closes the picker after
// onSelect, and path lets it hide the state's folder from its own sections.
export const GTD_PICKER_ORDER = ['todo', 'delegated', 'watch', 'reference', 'someday'];

export function buildGtdMovePickerSections(ctx, { classifyOne, classifyMany, renderStateIcon }) {
  const { account, messages, t } = ctx;
  if (!account?.gtd_enabled || !messages?.length) return [];
  const folders = resolveAccountGtdFolders(account);
  const items = GTD_PICKER_ORDER.map(state => ({
    key: state,
    label: t(`gtd.state.${state}`),
    path: folders[state],
    renderIcon: (size) => renderStateIcon(state, size),
    onSelect: () => {
      // GTD tags per thread, so a thread row's representative message is enough.
      if (messages.length === 1) void classifyOne(messages[0], state);
      else void classifyMany(messages, state);
    },
  }));
  return [{ key: 'gtd', heading: t('gtd.title'), items }];
}
