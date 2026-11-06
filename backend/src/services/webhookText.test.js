import { describe, expect, it } from 'vitest';
import { webhookText } from './webhookText.js';

describe('webhook preset text', () => {
  it('uses Chinese titles and sender labels while preserving mail text', () => {
    expect(webhookText('zhCN', { account: 'QQ', count: 1, sender: 'Alice', subject: 'Hello 世界' })).toEqual({
      title: 'QQ · 1 封新邮件', message: 'Hello 世界\n发件人: Alice',
    });
  });
  it.each([undefined, null, 'unknown', '__proto__'])('falls back to English for %s', language => {
    expect(webhookText(language, { account: 'Work', count: 2 })).toEqual({ title: 'Work · 2 new messages', message: 'New mail received' });
  });
  it.each([
    ['en', 1, '1 new message'], ['en', 2, '2 new messages'],
    ['ru', 1, '1 новое письмо'], ['ru', 2, '2 новых письма'], ['ru', 5, '5 новых писем'], ['ru', 21, '21 новое письмо'],
    ['pl', 2, '2 nowe wiadomości'], ['pl', 5, '5 nowych wiadomości'],
    ['cs', 2, '2 nové zprávy'], ['cs', 5, '5 nových zpráv'],
    ['de', 2, '2 neue Nachrichten'], ['fr', 2, '2 nouveaux messages'],
    ['es', 2, '2 mensajes nuevos'], ['it', 2, '2 nuovi messaggi'],
    ['ptBR', 2, '2 novas mensagens'], ['ko', 2, '새 메일 2개'],
  ])('formats %s count %s', (language, count, expected) => {
    expect(webhookText(language, { account: 'Work', count }).title).toBe(`Work · ${expected}`);
  });
  it('keeps the title on one line and supplies text when details are absent', () => {
    expect(webhookText('zhCN', { account: 'QQ\r\nTitle', count: 1 })).toEqual({ title: 'QQ Title · 1 封新邮件', message: '收到新邮件' });
  });
});
