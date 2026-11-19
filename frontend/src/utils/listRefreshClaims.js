// Knowing when the message list has actually reloaded (#748).
//
// mailflow:refresh asks the list to reload and is fire-and-forget: a dozen places dispatch it
// and none needs an answer. A resync after the app resumes does: until the list on screen has
// reloaded it may still show mail from before the phone slept, and "up to date" must not be said
// on the strength of the counts alone. So the resync's refresh carries a claim. The list takes
// it, and settles it when the reload that covers it lands (or fails): including one held back
// behind a load already under way, or deferred behind a message just opened.
//
// No list to take it (none mounted, as on a phone with a message open) means nothing on screen
// is out of date, so the wait is over at once. A list showing search results answers at once
// too: its folder list is not on screen, and reloads when the search is cleared.

export const LIST_REFRESH_EVENT = 'mailflow:refresh';

// Asks the list to reload and resolves when it has, or rejects when its reload failed.
export function refreshListAndWait(target = window) {
  return new Promise((resolve, reject) => {
    let claimed = false;
    const detail = {
      claim: () => {
        claimed = true;
        return { done: () => resolve(), fail: (error) => reject(error || new Error('The list could not be reloaded')) };
      },
    };
    target.dispatchEvent(new CustomEvent(LIST_REFRESH_EVENT, { detail }));
    // dispatchEvent runs the listeners before it returns: nobody claimed it, nothing to wait for.
    if (!claimed) resolve();
  });
}

// The claims a list holds until a reload settles them. A reload covers only the claims made
// before it started (mark()): one made while it was in flight may postdate what it fetched, so it
// waits for the next reload, which the same refresh event starts.
export function createClaimQueue() {
  let claims = [];
  let next = 0;
  return {
    add: (claim) => { if (claim) claims.push({ seq: next++, claim }); },
    mark: () => next,
    settle: (ok, error, upTo = next) => {
      const due = claims.filter(entry => entry.seq < upTo);
      claims = claims.filter(entry => entry.seq >= upTo);
      for (const { claim } of due) {
        if (ok) claim.done(); else claim.fail(error);
      }
    },
    get size() { return claims.length; },
  };
}
