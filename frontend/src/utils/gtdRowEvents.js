// GTD actions in core report the rows they changed here, and the GTD plugin's row chips listen
// (plugins/gtd/metadataStore.js registers when it loads), so core never imports plugin code.
// With no listener every call is a no-op.
let listener = null;

export function setGtdRowListener(next) {
  listener = next;
}

// Taken before a mutation and handed back with its outcome, so an outcome that lands after
// sign-out or a plugin toggle is dropped.
export const gtdRowSession = () => listener?.session() ?? null;
export const gtdRowLabeled = (message, state, date, session) => listener?.labeled(message, state, date, session);
export const gtdRowChanged = (message, session) => listener?.changed(message, session);
export const gtdRowsSettled = session => listener?.settled(session);
