const paths = {
  compose: <><path d="M4 20h16"/><path d="m14 4 6 6L9 21H3v-6Z"/></>,
  search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></>,
  contacts: <><circle cx="9" cy="8" r="3"/><path d="M3 20c0-4 2-6 6-6s6 2 6 6"/><path d="M17 7h4M19 5v4"/></>,
  inbox: <><path d="M3 5h18v14H3Z"/><path d="m3 13 5-1 2 3h4l2-3 5 1"/></>,
  folder: <path d="M3 6h7l2 2h9v11H3Z"/>,
  gtd: <><circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/></>,
  appearance: <><circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 0 0 18Z"/></>,
  settings: <><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/></>,
};

export default function CommandIcon({ name }) {
  return <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
    {paths[name] || paths.settings}
  </svg>;
}
