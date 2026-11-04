import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('./webhooks.js', () => ({ notifyWebhook: vi.fn() }));
vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('./pushNotifications.js', () => ({ sendPushToUser: vi.fn() }));
import { notifyWebhook } from './webhooks.js';
import { query } from './db.js';
import { sendPushToUser } from './pushNotifications.js';
import { notifyNewMail } from './notifyNewMail.js';
const settle = () => new Promise(resolve => setImmediate(resolve));
beforeEach(() => {
  vi.resetAllMocks();
  query.mockResolvedValue({ rows: [{ total: 7 }] });
  sendPushToUser.mockResolvedValue();
  notifyWebhook.mockResolvedValue({ sent: true });
});
describe('new mail Web Push', () => {
  it('uses the last eligible message and the user-wide unread badge', async () => {
    notifyNewMail({ userId: 'u', alertMessages: [{ subject: 'old' }, { id: 'm', fromName: 'Alice', subject: 'Hello' }], alertCount: 2 });
    await settle();
    expect(query.mock.calls[0][1]).toEqual(['u']);
    expect(sendPushToUser).toHaveBeenCalledWith('u', {
      title: 'Alice', body: '2 new messages', icon: '/icon-512.png', badge: '/badge-96.png', url: '/?m=m', unreadCount: 7,
    });
  });
  it('still sends when badge lookup fails, preserving fallbacks', async () => {
    query.mockRejectedValue(new Error('database unavailable'));
    notifyNewMail({ userId: 'u', alertMessages: [{}], alertCount: 1 });
    await settle();
    expect(sendPushToUser).toHaveBeenCalledWith('u', {
      title: 'New mail', body: '(no subject)', icon: '/icon-512.png', badge: '/badge-96.png', url: '/',
    });
  });
  it('contains asynchronous delivery errors', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    sendPushToUser.mockRejectedValue(new Error('offline'));
    expect(notifyNewMail({ userId: 'u', alertMessages: [{ fromEmail: 'a@example.com', subject: 'Hi' }], alertCount: 1 })).toBeUndefined();
    await settle();
    expect(warn).toHaveBeenCalledWith('Push notification error:', 'offline');
    warn.mockRestore();
  });
});

it('starts webhook delivery independently of badge lookup and contains its errors', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  query.mockReturnValue(new Promise(() => {}));
  notifyWebhook.mockRejectedValue(new Error('secret URL must never be logged'));
  const latest = { subject: 'Hello' };
  notifyNewMail({ userId: 'u', accountName: 'Work', alertMessages: [latest], alertCount: 1 });
  expect(notifyWebhook).toHaveBeenCalledWith({ userId: 'u', accountName: 'Work', count: 1, latest });
  await settle();
  expect(warn).toHaveBeenCalledWith('Webhook notification unavailable');
  expect(sendPushToUser).not.toHaveBeenCalled();
  warn.mockRestore();
});
