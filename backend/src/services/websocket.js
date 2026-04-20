export function setupWebSocket(wss, sessionMiddleware, imapManager) {
  wss.on('connection', (ws, req) => {
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
