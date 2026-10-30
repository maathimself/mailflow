import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { describe, it, expect, vi, afterEach } from 'vitest';
import WebSocket from 'ws';
vi.mock('./diagnosticsRing.js', () => ({ recordWsConnect: vi.fn(), recordWsDisconnect: vi.fn() }));
import { closeWebSocketClients, createWebSocketServer, setupWebSocket } from './websocket.js';

function setup(sessionMiddleware, manager = { connectAllForUser: vi.fn().mockResolvedValue() }) {
  const wss = new EventEmitter();
  const ws = Object.assign(new EventEmitter(), {
    readyState: 1, close: vi.fn(), terminate: vi.fn(), send: vi.fn(),
  });
  setupWebSocket(wss, sessionMiddleware, manager);
  wss.emit('connection', ws, { headers: {}, session: { userId: 'u1' }, sessionID: 'sess-1' });
  return { ws, manager };
}
afterEach(() => vi.restoreAllMocks());
describe('WebSocket failure recovery', () => {
  it('absorbs transport errors even while session lookup is pending', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { ws } = setup(() => {});
    expect(() => ws.emit('error', new Error('ECONNRESET'))).not.toThrow();
    expect(ws.terminate).toHaveBeenCalledOnce();
  });
  it('allows the browser to retry a session-store outage', () => {
    const { ws, manager } = setup((_req, _res, next) => next(new Error('Redis unavailable')));
    expect(ws.close).toHaveBeenCalledWith(1011, 'Session unavailable');
    expect(manager.connectAllForUser).not.toHaveBeenCalled();
  });
  it('does not authenticate a socket closed during session lookup', () => {
    let finish;
    const { ws, manager } = setup((_req, _res, next) => { finish = next; });
    ws.readyState = 3;
    finish();
    expect(ws.send).not.toHaveBeenCalled();
    expect(manager.connectAllForUser).not.toHaveBeenCalled();
  });
  it('handles a database failure during account reconnect without an unhandled rejection', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { ws } = setup((_req, _res, next) => next(), {
      connectAllForUser: vi.fn().mockRejectedValue(new Error('database unavailable')),
    });
    await Promise.resolve();
    expect(error).toHaveBeenCalledWith('WebSocket account reconnect failed:', 'database unavailable');
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'connected' }));
  });
});
describe('WebSocket session binding', () => {
  it('remembers the session that opened the socket, so ending that session can close it', () => {
    const { ws } = setup((_req, _res, next) => next());
    expect(ws).toMatchObject({ userId: 'u1', sessionId: 'sess-1' });
  });
});

const PING = JSON.stringify({ type: 'ping' });
const nextEvent = client => new Promise(resolve => {
  client.once('message', data => resolve(JSON.parse(data).type));
  client.once('close', () => resolve('close'));
});
// A real server built by createWebSocketServer(), as index.js builds it.
async function withSignedInClient(run) {
  const server = createServer();
  const wss = createWebSocketServer(server);
  setupWebSocket(wss, (req, _res, next) => { req.session = { userId: 'u1' }; next(); },
    { connectAllForUser: vi.fn().mockResolvedValue() });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
  try {
    expect(await nextEvent(client)).toBe('connected');
    await run(client);
  } finally {
    client.terminate();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => server.close(resolve));
  }
}
describe('WebSocket client messages', () => {
  it('ignores messages until the session lookup has authenticated the socket', () => {
    let finish;
    const { ws } = setup((_req, _res, next) => { finish = next; });
    const parse = vi.spyOn(JSON, 'parse');
    ws.emit('message', Buffer.from(PING));
    expect(parse).not.toHaveBeenCalled();
    expect(ws.send).not.toHaveBeenCalled();
    finish();
    ws.emit('message', Buffer.from(PING));
    expect(ws.send).toHaveBeenLastCalledWith(JSON.stringify({ type: 'pong' }));
  });
  it('ignores messages on a socket refused for having no session', () => {
    const { ws } = setup((req, _res, next) => { req.session = {}; next(); });
    expect(ws.close).toHaveBeenCalledWith(1008, 'Unauthorized');
    const parse = vi.spyOn(JSON, 'parse');
    ws.emit('message', Buffer.from(PING));
    expect(parse).not.toHaveBeenCalled();
    expect(ws.send).not.toHaveBeenCalled();
  });
  it('closes a connection that sends an oversized frame instead of parsing it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await withSignedInClient(async client => {
      client.send(PING);
      expect(await nextEvent(client)).toBe('pong');
      client.send(JSON.stringify({ type: 'ping', pad: 'x'.repeat(64 * 1024) }));
      expect(await nextEvent(client)).toBe('close');
    });
    expect(warn).toHaveBeenCalledWith('WebSocket transport error:', 'Max payload size exceeded');
  });
  it('closes a connection that splits a message across frames', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await withSignedInClient(async client => {
      client.send('{"type":', { fin: false });
      client.send('"ping"}');
      expect(await nextEvent(client)).toBe('close');
    });
    expect(warn).toHaveBeenCalledWith('WebSocket transport error:', 'Too many message fragments');
  });
});

describe('closing the clients on shutdown', () => {
  it('lets the HTTP server finish closing at once, the client told it is going away', async () => {
    const server = createServer();
    const wss = createWebSocketServer(server);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const client = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
    await new Promise(resolve => client.once('open', resolve));
    const started = Date.now();
    let serverClosed = false;
    const closed = new Promise(resolve => server.close(() => { serverClosed = true; resolve(); }));
    const told = new Promise(resolve => client.once('close', (code, reason) => resolve([code, String(reason)])));
    // An open WebSocket keeps the server from closing.
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(serverClosed).toBe(false);
    closeWebSocketClients(wss, 1001, 'Shutting down');
    expect(await told).toEqual([1001, 'Shutting down']);
    await closed;
    expect(Date.now() - started).toBeLessThan(2000);
    await new Promise(resolve => wss.close(resolve));
  });

  it('cuts off a client that does not answer the close handshake', () => {
    vi.useFakeTimers();
    try {
      const ws = { close: vi.fn(), terminate: vi.fn() };
      const wss = { clients: new Set([ws]) };
      closeWebSocketClients(wss, 1012, 'Restarting', { terminateAfterMs: 2000 });
      expect(ws.close).toHaveBeenCalledWith(1012, 'Restarting');
      vi.advanceTimersByTime(1999);
      expect(ws.terminate).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(ws.terminate).toHaveBeenCalledOnce();
      // One that went meanwhile is not in the set any more, and is left alone.
      const gone = { close: vi.fn(), terminate: vi.fn() };
      const later = { clients: new Set([gone]) };
      closeWebSocketClients(later, 1001, 'Shutting down');
      later.clients.delete(gone);
      vi.advanceTimersByTime(2000);
      expect(gone.terminate).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
