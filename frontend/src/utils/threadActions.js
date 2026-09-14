// Which messages a thread-wide action should actually operate on.
//
// A thread row stands for several messages, so acting on one means resolving the rest. The
// obvious place to get them is the cache populated when the thread was last expanded, and that
// is the trap: the cache is a snapshot, and a thread gains messages while you are looking at it.
//
// The observed failure: a GitHub thread received a reply after the thread was opened. Marking it
// read sent the bulk-read call for the CACHED ids, so the newer message was never included and
// stayed unread on the server. The UI then marked the cached copies read, so the row rendered as
// read with the unread message hidden inside it. The account badge showed 1 unread that could
// not be cleared by any amount of clicking, because the message was unreachable.
//
// The same staleness is worse for the destructive paths. A thread-wide delete or move built from
// a stale list silently leaves the newest messages behind, which is the bug the bulk-delete
// comment in MessageList already describes having fixed once.
//
// So the cache renders; the server decides what to act on. `allowCache` has to be asked for
// explicitly, and nothing currently asks, which is the point: a future caller has to think about
// staleness rather than inherit it by default.

/**
 * @param message      the row the action was invoked on
 * @param isThreadRow  false for an ordinary message row, which is already the whole action
 * @param cached       previously fetched sub-messages, used only when allowCache is true
 * @param fetchThread  () => Promise<{ messages }> — authoritative fetch
 * @param allowCache   opt in to the snapshot; only safe when staleness cannot change the outcome
 */
export async function resolveThreadMessages({ message, isThreadRow, cached, fetchThread, allowCache = false }) {
  if (!isThreadRow) return [message];
  if (allowCache && Array.isArray(cached) && cached.length > 0) return cached;
  const data = await fetchThread();
  // An empty or malformed response must not silently reduce the action to nothing: fall back to
  // the row itself, which is the same conservative choice the previous implementation made.
  return data?.messages?.length ? data.messages : [message];
}
