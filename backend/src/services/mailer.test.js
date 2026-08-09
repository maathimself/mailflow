import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('./encryption.js', () => ({ decrypt: vi.fn() }));
vi.mock('./hostValidation.js', () => ({ resolveForConnection: vi.fn() }));
vi.mock('./smtpTransport.js', () => ({ createSmtpTransport: vi.fn() }));
vi.mock('./connectionPolicy.js', () => ({ getConnectionPolicy: vi.fn() }));

import { sendSystemEmail } from './mailer.js';
import { query } from './db.js';
import { decrypt } from './encryption.js';
import { resolveForConnection } from './hostValidation.js';
import { createSmtpTransport } from './smtpTransport.js';
import { getConnectionPolicy } from './connectionPolicy.js';

const CONFIG = {
  host: 'mail.internal.lan',
  port: 587,
  tls: 'STARTTLS',
  user: 'system@internal.lan',
  pass: 'ENCRYPTED',
  fromName: 'MailFlow',
  fromEmail: 'system@internal.lan',
};

// #358: the System Email path must honor the admin's "Allow private / local hosts" policy,
// exactly as the personal-account path does. Previously it resolved the host with the
// default allowPrivate:false, so a self-hosted relay on a private IP was rejected even with
// the toggle on — and sendSystemEmail (verification/2FA codes, invites) has no fallback, so
// those emails hard-failed.
describe('sendSystemEmail honors allow-private-hosts policy (#358)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    query.mockResolvedValue({ rows: [{ value: JSON.stringify(CONFIG) }] });
    decrypt.mockReturnValue('smtp-secret');
    resolveForConnection.mockResolvedValue({ host: '10.0.0.5', servername: null });
    createSmtpTransport.mockReturnValue({ sendMail: vi.fn().mockResolvedValue({}) });
  });

  it('passes allowPrivate:true through to host resolution when the policy allows it', async () => {
    getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: true });

    await sendSystemEmail({ to: 'user@example.com', subject: 'Hi', text: 'body' });

    expect(resolveForConnection).toHaveBeenCalledWith('mail.internal.lan', { allowPrivate: true });
  });

  it('passes allowPrivate:false when the policy disallows private hosts', async () => {
    getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: false });

    await sendSystemEmail({ to: 'user@example.com', subject: 'Hi', text: 'body' });

    expect(resolveForConnection).toHaveBeenCalledWith('mail.internal.lan', { allowPrivate: false });
  });

  it('surfaces a private-host rejection from resolution rather than swallowing it', async () => {
    getConnectionPolicy.mockResolvedValue({ allowPrivateHosts: false });
    resolveForConnection.mockRejectedValue(new Error('Host resolves to a private or reserved IP address'));

    await expect(sendSystemEmail({ to: 'user@example.com', subject: 'Hi', text: 'body' }))
      .rejects.toThrow(/private or reserved/i);
    expect(createSmtpTransport).not.toHaveBeenCalled();
  });
});
