import { useState } from 'react';
import {
  GTD_COLORS, GTD_CHIP_BG, agingLabel, resolveRowDisplay,
} from '../utils/gtd.js';
import { formatDate } from '../utils/formatDate.js';

// One GTD entry row, shared by both display surfaces: the GTD browse list that
// replaces the message list (GtdTabList, roomier) and the denser right-sidebar
// section rows (GtdSidebarContent). Both draw the same skeleton — a left border in
// the row's state color, a header line (sender + optional Waiting aging pill + date),
// the subject, and Mailflow's native gray preview line — so the markup lives here
// once and each surface picks a size `variant` plus its own behavior.
//
// `variant` is the only style knob: it selects a byte-for-byte size table lifted
// from the two pre-extraction call sites (paddings, font sizes, header gap, the
// read-weight, and the two treatments that differ by surface — the unread cue and
// whether the subject brightens when unread). Nothing here is a restyle; the two
// tables reproduce each surface's prior pixels exactly.
const ROW_VARIANTS = {
  // GTD tab browse list: roomier rows, an unread dot, and an unread-aware subject.
  list: {
    padding: '9px 14px',
    borderBottom: '1px solid var(--border-subtle)',
    headerGap: 7,
    senderSize: 12.5,
    senderReadWeight: 400,
    dateSize: 11,
    subjectSize: 12.5,
    previewSize: 12,
    showUnreadDot: true,
    subjectUnreadAware: true,
  },
  // Right-sidebar section rows: denser, deeper left indent, and no unread dot —
  // unread reads through the sender's heavier weight alone (subject stays muted).
  sidebar: {
    padding: '7px 14px 7px 24px',
    borderBottom: 'none',
    headerGap: 6,
    senderSize: 12,
    senderReadWeight: 500,
    dateSize: 10.5,
    subjectSize: 11.5,
    previewSize: 11,
    showUnreadDot: false,
    subjectUnreadAware: false,
  },
};

export default function GtdEntryRow({
  thread, sectionKey, variant, selected, t,
  onClick, onContextMenu, renderHoverActions,
}) {
  const v = ROW_VARIANTS[variant];
  const isWaiting = sectionKey === 'waiting';
  const { rowState, unread, days, stale, sender } = resolveRowDisplay(thread, sectionKey);

  // Only the sidebar surface passes a hover cluster. Tracking `hovered` at all is
  // gated on that so the list rows keep mutating their background imperatively
  // without a re-render on every mouse enter/leave (their prior behavior).
  const [hovered, setHovered] = useState(false);
  const trackHover = !!renderHoverActions;

  return (
    <div
      onClick={onClick}
      onContextMenu={onContextMenu}
      style={{
        // Relative only when there's a hover cluster to anchor; the list surface
        // never sets position (its overlay-free rows render byte-identically static).
        ...(trackHover ? { position: 'relative' } : {}),
        padding: v.padding, borderBottom: v.borderBottom,
        cursor: 'pointer', borderLeft: `2px solid ${GTD_COLORS[rowState] || 'transparent'}`,
        background: selected ? 'var(--bg-tertiary)' : 'transparent',
      }}
      onMouseEnter={e => { if (trackHover) setHovered(true); if (!selected) e.currentTarget.style.background = 'var(--bg-hover)'; }}
      onMouseLeave={e => { if (trackHover) setHovered(false); if (!selected) e.currentTarget.style.background = 'transparent'; }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: v.headerGap }}>
        {v.showUnreadDot && unread && (
          <span style={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0, background: 'var(--accent)' }} />
        )}
        <span style={{
          fontSize: v.senderSize, fontWeight: unread ? 600 : v.senderReadWeight, flex: 1,
          color: unread ? 'var(--text-primary)' : 'var(--text-secondary)',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {sender}
        </span>
        {/* Aging pill carries the row's kind color (watch yellow / delegated orange),
            except when stale — staleness outranks kind and keeps the red styling. */}
        {isWaiting && days != null && (
          <span style={{
            fontSize: 10, fontWeight: 600, padding: '0 5px', borderRadius: 7, flexShrink: 0,
            color: stale ? '#ff9b9b' : GTD_COLORS[rowState],
            background: stale ? 'rgba(248,113,113,.16)' : GTD_CHIP_BG[rowState],
          }}>
            {agingLabel(days)}
          </span>
        )}
        <span style={{ fontSize: v.dateSize, color: 'var(--text-tertiary)', flexShrink: 0 }}>
          {formatDate(thread.date)}
        </span>
      </div>

      {/* Shared hover cluster (sidebar only) — same buttons the inbox rows get, overlaid
          (absolute) so it never shifts the row. Rendered here, after the header, only while
          hovered; the caller wires the section-scoped actions. */}
      {trackHover && hovered && renderHoverActions()}

      <div style={{
        fontSize: v.subjectSize, marginTop: 1,
        color: v.subjectUnreadAware && unread ? 'var(--text-primary)' : 'var(--text-secondary)',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}>
        {thread.subject || t('common.noSubject')}
      </div>
      {/* Message preview: Mailflow's native inbox line — the gray one-liner under the
          subject — on every GTD row. A cached AI gist (Waiting rows) wins over the raw
          snippet. Always rendered (native parity): rows keep a constant height even when
          neither gist nor snippet is populated yet. */}
      <div style={{
        fontSize: v.previewSize, color: 'var(--text-tertiary)', marginTop: 1,
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}>
        {thread.gist || thread.snippet || ' '}
      </div>
    </div>
  );
}
