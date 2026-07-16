import { resolveRowDisplay } from '../utils/gtd.js';
import GtdEntryRow from './GtdEntryRow.jsx';
import RowHoverActions from './RowHoverActions.jsx';

// A GTD entry row with triage wired on: the presentational GtdEntryRow plus this
// surface's affordances — a right-click context menu and the bottom-right hover action
// cluster. Shared by both GTD row surfaces: the right-sidebar section rows
// (GtdSidebarContent, variant="sidebar") and the GTD tab browse list that replaces the
// inbox message list (GtdTabList, variant="list"). `variant` is passed straight through
// to GtdEntryRow to pick its size table; every action here stays section-scoped via
// doneStates so "done"/"move"/"delete" only touch the section the row belongs to.
export default function GtdTriageRow({ thread, sectionKey, variant, selected, onOpen, rowActions, hoverQuickActions = true, t }) {
  const isWaiting = sectionKey === 'waiting';
  // The label states this row's "done" strips: a Waiting row clears its own kinds
  // (leaving GTD labels in other sections alone); other sections clear their own state.
  const { kinds } = resolveRowDisplay(thread, sectionKey);
  const doneStates = isWaiting ? kinds : [sectionKey];

  // Open the shared context menu carrying this row's section-scoped doneStates, so its
  // "done" and "move" strip only the section the row belongs to.
  const openMenuAt = (x, y, defaultMoveView = false) =>
    rowActions.openMenu({ x, y, message: thread, doneStates, defaultMoveView });

  // The shared entry row plus this surface's triage affordances: a right-click menu and the
  // hover action cluster (same buttons the inbox rows get). Both stay SECTION-SCOPED via
  // doneStates, and GTD rows only render for GTD accounts, so the "done" checkmark always
  // shows. `hoverQuickActions` gates ONLY the cluster (mirroring MessageList, where the
  // preference hides the hover buttons but never the context menu): when it's off we omit
  // renderHoverActions entirely, so GtdEntryRow won't even track hover — the right-click
  // menu stays live regardless.
  return (
    <GtdEntryRow
      thread={thread}
      sectionKey={sectionKey}
      variant={variant}
      selected={selected}
      t={t}
      onClick={onOpen}
      onContextMenu={e => { e.preventDefault(); openMenuAt(e.clientX, e.clientY); }}
      renderHoverActions={hoverQuickActions ? () => (
        <RowHoverActions
          message={thread}
          isRead={!!thread.is_read}
          background="var(--bg-tertiary)"
          onMarkRead={(e, m) => { e.stopPropagation(); rowActions.setRead(m, !m.is_read); }}
          onStar={(e, m) => { e.stopPropagation(); rowActions.toggleStar(m); }}
          onDelete={(e, m) => { e.stopPropagation(); rowActions.deleteRow(m, doneStates); }}
          onMove={e => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); openMenuAt(r.left, r.bottom + 4, true); }}
          onGtdDone={(e, m) => { e.stopPropagation(); rowActions.done(m, doneStates); }}
        />
      ) : undefined}
    />
  );
}
