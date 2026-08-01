const paths = {
  compose: <><path d="M4 20h16"/><path d="m14 4 6 6L9 21H3v-6Z"/></>,
  search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></>,
  contacts: <><circle cx="9" cy="8" r="3"/><path d="M3 20c0-4 2-6 6-6s6 2 6 6"/><path d="M17 7h4M19 5v4"/></>,
  inbox: <><path d="M3 5h18v14H3Z"/><path d="m3 13 5-1 2 3h4l2-3 5 1"/></>,
  folder: <path d="M3 6h7l2 2h9v11H3Z"/>,
  archive: <><rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v10h14V9M9 13h6"/></>,
  clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
  'mail-open': <><path d="m3 10 9 6 9-6v9H3Z"/><path d="m3 10 9-6 9 6"/></>,
  mail: <><rect x="3" y="5" width="18" height="14" rx="1"/><path d="m3 7 9 7 9-7"/></>,
  star: <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z"/>,
  trash: <><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13"/><path d="M10 11v5M14 11v5"/></>,
  shield: <><path d="m12 3 7 3v5c0 4.5-2.8 8-7 10-4.2-2-7-5.5-7-10V6Z"/><path d="M12 8v5M12 17h.01"/></>,
  'shield-check': <><path d="m12 3 7 3v5c0 4.5-2.8 8-7 10-4.2-2-7-5.5-7-10V6Z"/><path d="m9 12 2 2 4-4"/></>,
  reply: <><path d="m10 8-5 4 5 4"/><path d="M5 12h8a6 6 0 0 1 6 6"/></>,
  'reply-all': <><path d="m9 8-5 4 5 4M14 8l-5 4 5 4"/><path d="M9 12h5a6 6 0 0 1 6 6"/></>,
  forward: <><path d="m14 8 5 4-5 4"/><path d="M19 12h-8a6 6 0 0 0-6 6"/></>,
  'check-square': <><rect x="3" y="3" width="18" height="18" rx="2"/><path d="m8 12 3 3 6-7"/></>,
  eye: <><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"/><circle cx="12" cy="12" r="2.5"/></>,
  'user-check': <><circle cx="9" cy="8" r="3"/><path d="M3 20c0-4 2-6 6-6 2 0 3.5.5 4.5 1.5M16 17l2 2 4-5"/></>,
  calendar: <><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4M17 3v4M3 10h18"/></>,
  bookmark: <path d="M6 3h12v18l-6-4-6 4Z"/>,
  gtd: <><circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/></>,
  appearance: <><circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 0 0 18Z"/></>,
  settings: <><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/></>,
};

export default function CommandIcon({ name }) {
  return <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
    {paths[name] || paths.settings}
  </svg>;
}
