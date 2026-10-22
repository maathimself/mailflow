// Feather icons (MIT), one per GTD state. Drawn in currentColor so the picker tints them like
// FolderIcon; GTD's state colors are deliberately not used here.
const PATHS = {
  todo: <circle cx="12" cy="12" r="10"/>,
  delegated: <><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></>,
  watch: <><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></>,
  reference: <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>,
  someday: <><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></>,
};

export default function GtdStateIcon({ state, size = 13 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      {PATHS[state]}
    </svg>
  );
}
