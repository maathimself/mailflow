import { expect, it } from 'vitest';
import { parseMessage } from './messageParser.js';

it('maps the exact provider identifier without substituting RFC Message-ID', async () => {
  const parsed = await parseMessage({ uid: 1, emailId: '18446744073709551615', envelope: { messageId: '<shared@example.test>' } });
  expect(parsed.providerMsgid).toBe('18446744073709551615');
  expect((await parseMessage({ uid: 1, envelope: { messageId: '<shared@example.test>' } })).providerMsgid).toBeNull();
});
