// Closes a connection once no bytes have moved either way for idleMs. For the backup download and
// the restore upload, which run with Node's request timeout off and hold a lock while they last:
// a client that stops reading or sending would otherwise keep every later backup and restore out.
// It watches the byte counts rather than setting a socket timeout, so the keep-alive timeout Node
// sets after the response is left alone. Returns a function that stops the guard.
export function guardStalledTransfer(req, { idleMs = 5 * 60 * 1000, checkMs = Math.min(30000, idleMs / 4) } = {}) {
  const socket = req.socket;
  let moved = -1;
  let since = Date.now();
  const timer = setInterval(() => {
    const now = socket.bytesRead + socket.bytesWritten;
    if (now !== moved) {
      moved = now;
      since = Date.now();
    } else if (Date.now() - since >= idleMs) {
      clearInterval(timer);
      console.warn(`[backup] closing a transfer that moved no data for ${Math.round(idleMs / 1000)} s`);
      socket.destroy();
    }
  }, checkMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
