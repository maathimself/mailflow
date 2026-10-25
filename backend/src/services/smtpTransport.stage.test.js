import { createServer } from 'net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../routes/oauth.js', () => ({ refreshMicrosoftToken: vi.fn(), refreshGoogleToken: vi.fn() }));
import { createSmtpTransport, createStageTracker } from './smtpTransport.js';

// A real nodemailer transport against a small SMTP server on two loopback addresses, which
// stands for one host with two validated addresses. 127.0.0.1 misbehaves as `mode` says,
// 127.0.0.2 accepts. What #685 is about: nodemailer reports a connection lost after the
// message data as command 'CONN', the same as one that never connected.
let server;
let port;
let mode;
let pipelining = false;
let received;
beforeAll(async () => {
  server = createServer(socket => {
    socket.on('error', () => {});
    const failing = socket.localAddress === '127.0.0.1' || socket.localAddress === '::ffff:127.0.0.1';
    const drop = failing ? mode : 'none';
    if (drop === 'greeting') return socket.destroy();
    let buffered = '';
    let inData = false;
    socket.write('220 smtp.example.com ESMTP\r\n');
    socket.on('data', chunk => {
      buffered += chunk.toString('latin1');
      let end;
      while ((end = buffered.indexOf('\r\n')) >= 0) {
        const line = buffered.slice(0, end);
        buffered = buffered.slice(end + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            received.push(socket.localAddress.replace('::ffff:', ''));
            if (drop === 'afterData' || drop === 'data250') return socket.destroy();
            socket.write('250 2.0.0 Queued\r\n');
          }
          continue;
        }
        const verb = line.split(/[ :]/)[0].toUpperCase();
        if (verb === 'EHLO') socket.write(pipelining ? '250-smtp.example.com\r\n250 PIPELINING\r\n' : '250 smtp.example.com\r\n');
        else if (verb === 'MAIL') {
          if (drop === 'afterMail') return socket.destroy();
          socket.write('250 2.1.0 OK\r\n');
        } else if (verb === 'RCPT') socket.write(drop === 'rejectRcpt' ? '550 5.1.1 No such user\r\n' : '250 2.1.5 OK\r\n');
        else if (verb === 'DATA') {
          if (drop === 'beforeBody') return socket.destroy();
          if (drop === 'rejectRcpt') { socket.write(pipelining ? '554 5.5.1 No valid recipients\r\n' : '503 5.5.1 RCPT first\r\n'); continue; }
          inData = true;
          // Some servers answer DATA with 250, and nodemailer streams the body all the same.
          socket.write(drop === 'data250' ? '250 2.0.0 Send the data\r\n' : '354 Go ahead\r\n');
        } else if (verb === 'QUIT') socket.end('221 2.0.0 Bye\r\n');
        else socket.write('502 5.5.1 Unrecognized command\r\n');
      }
    });
  });
  await new Promise(resolve => server.listen(0, '0.0.0.0', resolve));
  port = server.address().port;
});
afterAll(() => new Promise(resolve => server.close(resolve)));
beforeEach(() => {
  received = [];
  pipelining = false;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

const resolved = { host: '127.0.0.1', addresses: ['127.0.0.1', '127.0.0.2'] };
const message = { from: 'me@example.com', to: 'you@example.com', subject: 'Hi', text: 'Hello' };
const send = trackStage => createSmtpTransport(resolved, { port, secure: false, ignoreTLS: true }, undefined, { trackStage })
  .sendMail(message).catch(err => err);

describe('address failover and the SMTP stage', () => {
  it('without tracking, a connection lost after the data still goes to the next address (#685)', async () => {
    mode = 'afterData';
    const result = await send(false);
    expect(result.accepted).toEqual(['you@example.com']);
    // The first server had the whole message before it dropped: a second delivery.
    expect(received).toEqual(['127.0.0.1', '127.0.0.2']);
  });

  it('with tracking, never fails over once the body started, and says how far it got', async () => {
    mode = 'afterData';
    const err = await send(true);
    expect(err).toBeInstanceOf(Error);
    expect(err.command).toBe('CONN');
    expect(err.smtpStage).toEqual({ mailFromSent: true, bodyStarted: true });
    expect(received).toEqual(['127.0.0.1']);
  });

  it('with tracking, never fails over once MAIL FROM went out', async () => {
    mode = 'afterMail';
    const err = await send(true);
    expect(err.command).toBe('CONN');
    expect(err.smtpStage).toEqual({ mailFromSent: true, bodyStarted: false });
    expect(received).toEqual([]);
  });

  it('with tracking, still fails over a connection that never reached MAIL FROM', async () => {
    mode = 'greeting';
    const result = await send(true);
    expect(result.accepted).toEqual(['you@example.com']);
    expect(received).toEqual(['127.0.0.2']);
  });
});

describe('with PIPELINING, where DATA goes out with the envelope before any reply', () => {
  it('a connection lost before the server\'s 354 never had the body', async () => {
    pipelining = true;
    mode = 'beforeBody';
    const err = await send(true);
    expect(err.command).toBe('CONN');
    expect(err.smtpStage).toEqual({ mailFromSent: true, bodyStarted: false });
    expect(received).toEqual([]);
  });

  it('a connection lost after the 354 may have delivered it', async () => {
    pipelining = true;
    mode = 'afterData';
    const err = await send(true);
    expect(err.smtpStage).toEqual({ mailFromSent: true, bodyStarted: true });
    expect(received).toEqual(['127.0.0.1']);
  });

  it('still sends normally', async () => {
    pipelining = true;
    mode = 'none';
    const result = await send(true);
    expect(result.accepted).toEqual(['you@example.com']);
  });
});

describe('a server that answers DATA with 250', () => {
  it.each([false, true])('has the body once that reply came (PIPELINING %s), so a drop after it is not retried', async withPipelining => {
    pipelining = withPipelining;
    mode = 'data250';
    const err = await send(true);
    expect(err.command).toBe('CONN');
    expect(err.smtpStage).toEqual({ mailFromSent: true, bodyStarted: true });
    expect(received).toEqual(['127.0.0.1']);
  });
});

describe('a server that refuses every recipient', () => {
  it.each([false, true])('never had the body (PIPELINING %s)', async withPipelining => {
    pipelining = withPipelining;
    mode = 'rejectRcpt';
    const err = await send(true);
    expect(err.responseCode).toBe(550);
    expect(err.smtpStage).toEqual({ mailFromSent: true, bodyStarted: false });
  });
});

describe('createStageTracker', () => {
  const run = lines => {
    const { stage, transportOptions: { logger } } = createStageTracker();
    for (const [tnx, line] of lines) logger.debug({ tnx }, line);
    return stage;
  };
  const MAIL = ['client', 'MAIL FROM:<x@example.com>'];
  const RCPT = ['client', 'RCPT TO:<y@example.com>'];
  const DATA = ['client', 'DATA'];
  const ok = ['server', '250 OK'];

  it('matches each reply to the command it answers, with and without PIPELINING', () => {
    expect(run([MAIL, ok, RCPT, ok, DATA, ['server', '354 Go ahead']])).toEqual({ mailFromSent: true, bodyStarted: true });
    expect(run([MAIL, RCPT, RCPT, DATA, ok, ok, ok, ['server', '354 Go ahead']])).toEqual({ mailFromSent: true, bodyStarted: true });
    // A 250 to DATA starts the body as a 354 does.
    expect(run([MAIL, RCPT, DATA, ok, ok, ['server', '250 Send the data']])).toEqual({ mailFromSent: true, bodyStarted: true });
    // The 250s that answer MAIL and RCPT start nothing, even with DATA already written.
    expect(run([MAIL, RCPT, DATA, ok, ok])).toEqual({ mailFromSent: true, bodyStarted: false });
    // Every recipient refused: DATA answered with an error.
    expect(run([MAIL, RCPT, DATA, ok, ['server', '550 No such user'], ['server', '554 No valid recipients'], ['client', 'QUIT'], ['server', '221 Bye']]))
      .toEqual({ mailFromSent: true, bodyStarted: false });
  });

  it('ignores everything before MAIL FROM', () => {
    expect(run([['client', 'EHLO example.com'], ['server', '354 odd'], ['client', 'DATA'], ['server', '250 OK']]))
      .toEqual({ mailFromSent: false, bodyStarted: false });
  });

  it('counts the body as started once DATA was written whenever the matching cannot be trusted', () => {
    // A reply no command is waiting for.
    expect(run([MAIL, ok, ok, DATA])).toEqual({ mailFromSent: true, bodyStarted: true });
    expect(run([MAIL, DATA, ok, ok, ['server', '250 extra']])).toEqual({ mailFromSent: true, bodyStarted: true });
    // A command it does not follow.
    expect(run([MAIL, ['client', 'RSET'], DATA])).toEqual({ mailFromSent: true, bodyStarted: true });
    // Without DATA written, nothing can have been delivered.
    expect(run([MAIL, ['client', 'RSET'], ok, ok])).toEqual({ mailFromSent: true, bodyStarted: false });
  });

  it('notes MAIL FROM from the client and the 354 that starts the body from the server', () => {
    const { stage, transportOptions } = createStageTracker();
    const { logger } = transportOptions;
    expect(transportOptions.transactionLog).toBe(true);
    logger.debug({ tnx: 'server' }, 'MAIL FROM:<x@example.com>');
    logger.debug({ tnx: 'client' }, 'EHLO example.com');
    logger.debug({ tnx: 'server' }, '354 before any transaction');
    expect(stage).toEqual({ mailFromSent: false, bodyStarted: false });
    logger.debug({ tnx: 'client' }, 'MAIL FROM:<x@example.com> SIZE=12');
    // The DATA command alone, as PIPELINING writes it, starts nothing.
    logger.debug({ tnx: 'client' }, 'DATA');
    logger.debug({ tnx: 'server' }, '250 2.1.0 OK');
    expect(stage).toEqual({ mailFromSent: true, bodyStarted: false });
    logger.debug({ tnx: 'server' }, '354 Go ahead');
    expect(stage).toEqual({ mailFromSent: true, bodyStarted: true });
  });
});
