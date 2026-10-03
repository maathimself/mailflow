import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import net from 'node:net';
import http from 'node:http';
import { ImapFlow } from 'imapflow';
vi.mock('../index.js', () => ({ imapManager: {} }));
import { makeClientCfg } from './imapManager.js';
import { createSmtpTransport } from './smtpTransport.js';

const sockets = new Set();
const connects = [];
const smtpCommands = [];
let imap, smtp, proxy;
let smtpConnections = 0;
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server => server.address().port;
const track = socket => { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); };
function lines(socket, callback) {
  let buffer = '';
  socket.on('data', chunk => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf('\r\n')) >= 0) { const line = buffer.slice(0, index); buffer = buffer.slice(index + 2); callback(line); }
  });
}
beforeAll(async () => {
  imap = net.createServer(socket => {
    track(socket); socket.write('* OK test IMAP\r\n');
    lines(socket, line => {
      const [tag, command] = line.split(' ');
      if (command === 'CAPABILITY') socket.write('* CAPABILITY IMAP4rev1\r\n');
      if (command === 'LIST') socket.write('* LIST (\\Noselect) "/" ""\r\n');
      if (command === 'LOGOUT') { socket.end(`* BYE\r\n${tag} OK logout\r\n`); return; }
      socket.write(`${tag} OK ${command} complete\r\n`);
    });
  });
  smtp = net.createServer(socket => {
    smtpConnections++;
    track(socket); socket.write('220 test SMTP\r\n');
    lines(socket, line => {
      smtpCommands.push(line.split(' ')[0]);
      if (line.startsWith('EHLO')) socket.write('250-test\r\n250 AUTH PLAIN\r\n');
      else if (line.startsWith('AUTH PLAIN')) socket.write('235 authenticated\r\n');
      else if (line === 'QUIT') socket.end('221 bye\r\n');
      else socket.write('250 OK\r\n');
    });
  });
  proxy = http.createServer();
  proxy.on('connect', (req, socket, head) => {
    track(socket); connects.push({ destination: req.url, auth: req.headers['proxy-authorization'] });
    if (req.headers['proxy-authorization'] !== `Basic ${Buffer.from('proxy-user:p:a% ss').toString('base64')}`) { socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'); return; }
    const [host, destinationPort] = req.url.split(':');
    const upstream = net.connect(Number(destinationPort), host, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(socket); socket.pipe(upstream);
    });
    track(upstream);
    socket.on('close', () => upstream.destroy()); upstream.on('close', () => socket.destroy());
  });
  await Promise.all([listen(imap), listen(smtp), listen(proxy)]);
});
afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  await Promise.all([imap, smtp, proxy].map(server => new Promise(resolve => server.close(resolve))));
});
const proxyUrl = () => `http://proxy-user:p%3Aa%25%20ss@127.0.0.1:${port(proxy)}`;

describe('real HTTP CONNECT mail connections', () => {
  it('authenticates IMAP through the configured tunnel using a pinned destination', async () => {
    const cfg = makeClientCfg({ imap_port: port(imap), imap_tls: false, auth_user: 'test-user', auth_pass: 'test-password' }, { host: '127.0.0.1', servername: 'imap.example.com' }, { policy: { allowInsecureTls: true, mailProxyUrl: proxyUrl() } });
    const client = new ImapFlow({ ...cfg, doSTARTTLS: false });
    client.on('error', () => {});
    try { await client.connect(); expect(client.authenticated).toBeTruthy(); }
    finally { client.close(); }
    expect(connects.at(-1).destination).toBe(`127.0.0.1:${port(imap)}`);
  });
  it('verifies SMTP through CONNECT without issuing MAIL or DATA', async () => {
    const transport = createSmtpTransport({ host: '127.0.0.1', servername: 'smtp.example.com' }, { proxy: proxyUrl(), port: port(smtp), secure: false, ignoreTLS: true, auth: { user: 'test-user', pass: 'test-password' }, tls: { servername: 'smtp.example.com', rejectUnauthorized: true } });
    await expect(transport.verify()).resolves.toBe(true);
    expect(connects.at(-1).destination).toBe(`127.0.0.1:${port(smtp)}`);
    expect(smtpCommands).toContain('AUTH');
    expect(smtpCommands).not.toContain('MAIL'); expect(smtpCommands).not.toContain('DATA');
  });
  it('reports proxy rejection without attempting direct SMTP access or exposing credentials', async () => {
    const start = smtpConnections;
    const transport = createSmtpTransport({ host: '127.0.0.1' }, { proxy: `http://wrong:secret@127.0.0.1:${port(proxy)}`, port: port(smtp), secure: false, ignoreTLS: true });
    await expect(transport.verify()).rejects.toMatchObject({ stage: 'proxy', message: 'Proxy authentication failed. Check the proxy credentials.' });
    expect(smtpConnections).toBe(start);
  });
  it('reports an unreachable proxy as a proxy failure without connecting directly', async () => {
    const unused = net.createServer(); await listen(unused); const unusedPort = port(unused);
    await new Promise(resolve => unused.close(resolve));
    const start = smtpConnections;
    const transport = createSmtpTransport({ host: '127.0.0.1' }, { proxy: `http://127.0.0.1:${unusedPort}`, port: port(smtp), secure: false, ignoreTLS: true });
    await expect(transport.verify()).rejects.toMatchObject({ stage: 'proxy', message: 'Outbound mail proxy connection failed. Check its settings and backend connectivity.' });
    expect(smtpConnections).toBe(start);
  });

});
