import { afterEach, describe, expect, it } from 'vitest';
import http from 'http';
import net from 'net';
import { guardStalledTransfer } from './stallGuard.js';

let server;
afterEach(() => new Promise(resolve => (server ? server.close(resolve) : resolve())));

function listen(handler) {
  server = http.createServer(handler);
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// A raw client: headers and the first part of an upload, then whatever `rest` does.
function upload(port, rest) {
  return new Promise(resolve => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write('POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 100000\r\n\r\n' + 'a'.repeat(1000));
      rest(socket);
    });
    socket.on('close', () => resolve(Date.now()));
    socket.on('error', () => {});
  });
}

describe('guardStalledTransfer', () => {
  it('closes an upload that stops arriving', async () => {
    const port = await listen((req) => { guardStalledTransfer(req, { idleMs: 150, checkMs: 25 }); req.resume(); });
    const started = Date.now();
    const closedAt = await upload(port, () => {});
    expect(closedAt - started).toBeGreaterThanOrEqual(150);
    expect(closedAt - started).toBeLessThan(2000);
  });

  it('leaves an upload alone while it keeps arriving, and once stopped', async () => {
    let finished;
    const ended = new Promise(resolve => { finished = resolve; });
    const port = await listen((req, res) => {
      const stop = guardStalledTransfer(req, { idleMs: 150, checkMs: 25 });
      req.resume();
      req.on('end', () => { stop(); res.end('ok'); finished(); });
    });
    let closed = false;
    const socket = net.connect(port, '127.0.0.1');
    socket.on('close', () => { closed = true; });
    socket.on('error', () => {});
    await new Promise(resolve => socket.once('connect', resolve));
    socket.write('POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 10000\r\n\r\n');
    // 600 ms of upload in all, four times the idle limit, never idle for long.
    for (let i = 0; i < 10; i++) {
      socket.write('a'.repeat(1000));
      await new Promise(r => setTimeout(r, 60));
    }
    await ended;
    // The guard is off now: an idle keep-alive connection is not closed by it.
    await new Promise(r => setTimeout(r, 300));
    expect(closed).toBe(false);
    socket.destroy();
  });
});
