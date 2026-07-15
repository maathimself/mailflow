// Pure view-model for a CardDAV per-book row in the integrations panel. The
// three stored role flags (write-target / subscribed / lookup) collapse into one
// role label, one capability badge, and the enabled/disabled/checked state of
// the Subscribe and Look-up-senders toggles and the write-target radio. Kept out
// of the AdminPanel JSX so the control logic is unit-testable without a DOM.

// The effective role, most-privileged first — the label shown on the row.
export function cardDavBookRole(book) {
  if (book.isWriteTarget) return 'writeTarget';
  if (book.isSubscribed) return 'subscribed';
  if (book.isLookupSource) return 'lookupOnly';
  return 'ignored';
}

// The observed write capability badge. Read-only when the server denies both
// update and delete; unknown while any capability is still unconfirmed;
// otherwise writable.
export function cardDavBookCapability(book) {
  const caps = book.capabilities || {};
  if (caps.update === 'denied' && caps.delete === 'denied') return 'readOnly';
  if ([caps.create, caps.update, caps.delete].some(value => value == null || value === 'unknown')) {
    return 'unknownCapability';
  }
  return 'writable';
}

// Whether emailing someone publishes them to the write-target book, and the patch
// the toggle sends when clicked.
//
// The setting is absent from every connection made before it existed, and absent
// must read as OFF: publishing stays a deliberate act (create or promote) unless
// the user opts in. Only an explicit `true` enables it — a missing key is not
// consent, so this compares rather than coercing.
export function publishEmailedContactsToggle(status) {
  const checked = status?.publishEmailedContacts === true;
  return { checked, patch: { publishEmailedContacts: !checked } };
}

// Everything a row needs to render its controls and decide which are locked.
export function cardDavBookControls(book) {
  const caps = book.capabilities || {};
  const isWriteTarget = Boolean(book.isWriteTarget);
  return {
    role: cardDavBookRole(book),
    capability: cardDavBookCapability(book),
    subscribeChecked: Boolean(book.isSubscribed),
    lookupChecked: Boolean(book.isLookupSource),
    isWriteTarget,
    // A book the server won't let MailFlow create in can never be the
    // write-target, so its radio is disabled.
    writeTargetDisabled: caps.create === 'denied',
    // The write-target must stay subscribed (the backend rejects unsubscribing
    // it), so its Subscribe toggle is locked on.
    subscribeDisabled: isWriteTarget,
  };
}
