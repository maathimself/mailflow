// Derive the expected origin from APP_URL once at startup.
// If APP_URL is not set, origin validation is skipped (dev / unconfigured installs).
const ALLOWED_ORIGIN = (() => {
  try { return process.env.APP_URL ? new URL(process.env.APP_URL).origin : null; } catch (_) { return null; }
})();

export function setupWebSocket(wss, sessionMiddleware, imapManager) {
  wss.on('connection', (ws, req) => {
    // Reject cross-origin WebSocket connections when APP_URL is configured.
    // Browsers always send Origin on WS upgrades; absence means a non-browser client.
    const origin = req.headers.origin;
    if (ALLOWED_ORIGIN && origin && origin !== ALLOWED_ORIGIN) {
      ws.close(1008, 'Forbidden');
      return;
    }

    // Parse session from upgrade request
    const fakeRes = {
      getHeader: () => {},
      setHeader: () => {},
      end: () => {}
    };

    sessionMiddleware(req, fakeRes, () => {
      const userId = req.session?.userId;
      if (!userId) {
        ws.close(1008, 'Unauthorized');
        return;
      }
      ws.userId = userId;
      console.log(`WebSocket connected for user ${userId}`);
      ws.send(JSON.stringify({ type: 'connected' }));
      // Re-establish IMAP connections if the server restarted (skips already-connected accounts)
      imapManager.connectAllForUser(userId);
    });

    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data);
        if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
      } catch (_) {}
    });

    ws.on('close', () => {
      console.log(`WebSocket disconnected`);
    });
  });
}
