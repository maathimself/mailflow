// Per-account automatic Cc and Bcc (#491).
//
// The composer adds the From account's lists as ordinary chips, which the user can see and
// remove before sending; the server never adds them. Reply/Reply All toggles and From switches
// recompute the automatic part from the lists rather than filtering the chips on screen, so the
// result does not depend on the order the user clicked in.
//
//   fields  { to, cc, bcc }: arrays of chip strings, "a@x.org" or "Name <a@x.org>"
//   lists   { cc, bcc }: one account's automatic addresses
//   auto    what the composer remembers from one change to the next:
//             lists       the From account's lists
//             placed      { cc, bcc }: Sets of the addresses the composer itself appended
//             present     the list addresses that were in To, Cc or Bcc after the last change
//             suppressed  addresses the user removed, which are never added automatically again

// Same rule as ChipInput's chipEmail, compared without case.
export function bareAddress(chip) {
  const text = typeof chip === 'string' ? chip : '';
  const match = text.match(/<([^>]+)>/);
  return (match ? match[1] : text).trim().toLowerCase();
}

export function autoListsOf(account) {
  const list = (value) => (Array.isArray(value) ? value : [])
    .filter(address => typeof address === 'string')
    .map(address => address.trim())
    .filter(Boolean);
  return { cc: list(account?.auto_cc_addresses), bcc: list(account?.auto_bcc_addresses) };
}

function addressesIn(fields) {
  return new Set([...fields.to, ...fields.cc, ...fields.bcc].map(bareAddress));
}

// Appends each list address that is neither suppressed nor already in To, Cc or Bcc, so an
// address in both lists goes to Cc only. A field with nothing to add comes back as the same
// array, which makes setting it a no-op for accounts without lists.
export function addAutoRecipients(fields, lists, suppressed = new Set()) {
  const seen = addressesIn(fields);
  const placed = { cc: new Set(), bcc: new Set() };
  const append = (chips, list, into) => {
    const added = [];
    for (const address of list) {
      const key = bareAddress(address);
      if (!key || seen.has(key) || suppressed.has(key)) continue;
      seen.add(key);
      into.add(key);
      added.push(address);
    }
    return added.length ? [...chips, ...added] : chips;
  };
  return {
    cc: append(fields.cc, lists.cc, placed.cc),
    bcc: append(fields.bcc, lists.bcc, placed.bcc),
    placed,
  };
}

export function presentAuto(lists, fields) {
  const listed = new Set([...lists.cc, ...lists.bcc].map(bareAddress));
  return new Set([...addressesIn(fields)].filter(key => listed.has(key)));
}

// Between two changes only the user removes chips, so an address that was present after the
// last change and is gone now was removed by hand: by its x, Backspace or the chip menu.
export function noteRemoved(present, suppressed, fields) {
  const now = addressesIn(fields);
  const next = new Set(suppressed);
  for (const key of present) if (!now.has(key)) next.add(key);
  return next;
}

// The composer appended each placed address once, as the bare list entry, so only that chip is
// taken out. A second copy or a named chip for the same address is one the user added.
function withoutPlaced(chips, placed) {
  const left = new Set(placed);
  const kept = chips.filter(chip => {
    const key = bareAddress(chip);
    if (!left.has(key) || chip.includes('<')) return true;
    left.delete(key);
    return false;
  });
  return kept.length === chips.length ? chips : kept;
}

// base is what the recipients become before the lists are added; fields is what is on screen
// now, which is where removals since the last change show up.
function recompute(base, lists, auto, fields) {
  const suppressed = noteRemoved(auto.present, auto.suppressed, fields);
  const { cc, bcc, placed } = addAutoRecipients(base, lists, suppressed);
  const next = { to: base.to, cc, bcc };
  return { ...next, auto: { lists, placed, present: presentAuto(lists, next), suppressed } };
}

export function openAutoRecipients(fields, lists) {
  return recompute(fields, lists, { present: new Set(), suppressed: new Set() }, fields);
}

// Rebuilds the recipients by the composer's existing rules, then adds the lists again:
//   Reply      To is the original sender; Cc and Bcc start empty.
//   Reply All  To is the original sender; Cc is the thread's recipients, or the current Cc when
//              the thread has none; Bcc is kept.
// Only what the composer placed is taken out of a Cc or Bcc that is kept, so typed and thread
// recipients follow those rules exactly as before.
export function replyTypeFields({ all, originalTo, allRecipients, fields, auto }) {
  const base = all
    ? {
      to: originalTo,
      cc: allRecipients.length ? allRecipients : withoutPlaced(fields.cc, auto.placed.cc),
      bcc: withoutPlaced(fields.bcc, auto.placed.bcc),
    }
    : { to: originalTo, cc: [], bcc: [] };
  return recompute(base, auto.lists, auto, fields);
}

// Switching From to another account takes out only what the old account's lists placed, so the
// recipients the message came with stay where they are.
export function swapAccountFields({ fields, auto, lists }) {
  const base = {
    to: fields.to,
    cc: withoutPlaced(fields.cc, auto.placed.cc),
    bcc: withoutPlaced(fields.bcc, auto.placed.bcc),
  };
  return recompute(base, lists, auto, fields);
}

// Settings input. It only splits, so a malformed entry reaches the server as typed and its 400
// names it, instead of being dropped or rewritten here.
export function splitAddressInput(text) {
  return String(text ?? '').split(/[,;\s]+/).filter(Boolean);
}

// Both lists on every save, like every other field the account form sends. The text the user
// edited wins; otherwise the account's saved list goes back unchanged.
export function autoRecipientFields(form) {
  const field = (text, saved) => (text != null
    ? splitAddressInput(text)
    : (Array.isArray(saved) ? [...saved] : []));
  return {
    auto_cc_addresses: field(form?.auto_cc_text, form?.auto_cc_addresses),
    auto_bcc_addresses: field(form?.auto_bcc_text, form?.auto_bcc_addresses),
  };
}
