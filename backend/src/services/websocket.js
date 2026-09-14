import { recordWsConnect, recordWsDisconnect } from './diagnosticsRing.js';

// Derive the expected origin from APP_URL once at startup.
// If APP_URL is not set, origin validation is skipped — log a warning so operators know.
const ALLOWED_ORIGIN = (() => {
  try { return process.env.APP_URL ? new URL(process.env.APP_URL).origin : null; } catch { return null; }
})();
if (!ALLOWED_ORIGIN) {
  if (process.env.NODE_ENV === 'production') {
    console.error('FATAL: APP_URL is not set in production — WebSocket connections with an Origin header will be rejected.');
  } else {
    console.warn('WARNING: APP_URL is not set — WebSocket origin validation is disabled. Set APP_URL in .env for production.');
  }
}

export function setupWebSocket(wss, sessionMiddleware, imapManager) {
  wss.on('connection', (ws, req) => {
    // Transport errors can arrive during session lookup, before authentication.
    ws.on('error', err => {
      console.warn('WebSocket transport error:', err.message);
      ws.terminate();
    });
    // Reject cross-origin WebSocket connections when APP_URL is configured.
    // Browsers always send Origin on WS upgrades; absence means a non-browser client.
    const origin = req.headers.origin;
    if (ALLOWED_ORIGIN && origin && origin !== ALLOWED_ORIGIN) {
      ws.close(1008, 'Forbidden');
      return;
    }
    // In production without APP_URL, reject browser connections (non-browser clients omit Origin)
    if (!ALLOWED_ORIGIN && process.env.NODE_ENV === 'production' && origin) {
      ws.close(1008, 'Forbidden');
      return;
    }

    // Parse session from upgrade request
    const fakeRes = {
      getHeader: () => {},
      setHeader: () => {},
      end: () => {}
    };

    sessionMiddleware(req, fakeRes, (err) => {
      if (ws.readyState !== 1) return;
      if (err) {
        // A temporary session-store outage should be retried, not treated as
        // invalid credentials (1008 disables automatic browser reconnects).
        ws.close(1011, 'Session unavailable');
        return;
      }
      const userId = req.session?.userId;
      if (!userId) {
        ws.close(1008, 'Unauthorized');
        return;
      }
      if (req.session.locked) {
        // Screen lock (#235) is server-enforced: don't stream live mail to a locked
        // session. The client closes its own socket on lock; this blocks a new one.
        ws.close(1008, 'Locked');
        return;
      }
      ws.userId = userId;
      recordWsConnect();
      ws._diagCounted = true;
      console.log(`WebSocket connected for user ${userId}`);
      ws.send(JSON.stringify({ type: 'connected' }));
      // Re-establish IMAP connections if the server restarted (skips already-connected accounts)
      imapManager.connectAllForUser(userId).catch(err => {
        console.error('WebSocket account reconnect failed:', err.message);
      });
    });

    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data);
        if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
      } catch { /* ignore malformed client message */ }
    });

    ws.on('close', () => {
      if (ws._diagCounted) recordWsDisconnect();
      console.log(`WebSocket disconnected`);
    });
  });
}
