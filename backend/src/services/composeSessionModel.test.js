import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  MAX_COMPOSE_SESSIONS,
  findComposeConflicts,
  meaningfulComposeSession,
  normalizeComposeChanges,
  normalizeComposeClientId,
} from './composeSessionModel.js';

describe('composeSessionModel', () => {
  it('relies on the unique user-slot constraint without a redundant index', () => {
    const migration = readFileSync(
      new URL('../../migrations/0053_compose_sessions.sql', import.meta.url),
      'utf8',
    );
    expect(migration).toContain('UNIQUE (user_id, slot)');
    expect(migration).not.toContain('idx_compose_sessions_user');
  });

  it('pins the workspace to nine slots', () => {
    expect(MAX_COMPOSE_SESSIONS).toBe(9);
  });

  it('normalizes editable fields without admitting ownership fields', () => {
    expect(normalizeComposeChanges({
      subject: '  Hello\r\nBcc: injected@example.com  ',
      to: [' A <a@example.com> '],
      priority: 'high',
      slot: 8,
      user_id: 'attacker',
    })).toEqual({
      subject: 'HelloBcc: injected@example.com',
      to: ['A <a@example.com>'],
      priority: 'high',
    });
  });

  it.each([
    [null, 'changes must be an object'],
    [[], 'changes must be an object'],
    ['subject=x', 'changes must be an object'],
    [{ accountId: 'not-a-uuid' }, 'accountId must be a UUID or null'],
    [{ aliasId: 42 }, 'aliasId must be a UUID or null'],
    [{ mode: 1 }, 'unsupported compose mode'],
    [{ to: 'a@example.com' }, 'to must be an array'],
    [{ cc: [42] }, 'cc[0] is empty or not a string'],
    [{ bcc: ['missing-at'] }, 'bcc[0] is not a valid email address'],
    [{ subject: false }, 'subject must be a string'],
    [{ body: null }, 'body must be a string'],
    [{ bodyIsHtml: 'true' }, 'bodyIsHtml must be a boolean'],
    [{ quotedBody: 42 }, 'quotedBody must be a string or null'],
    [{ quotedBodyHtml: [] }, 'quotedBodyHtml must be a string or null'],
    [{ editedSignature: false }, 'editedSignature must be a string or null'],
    [{ forwardedAttachments: {} }, 'forwardedAttachments must be an array'],
    [{ forwardedAttachments: [{}] }, 'forwardedAttachments[0].messageId is invalid'],
    [{ forwardedAttachments: [{
      messageId: '11111111-1111-4111-8111-111111111111',
      part: '',
    }] }, 'forwardedAttachments[0].part is required'],
    [{ priority: 'urgent' }, 'priority must be low, normal, or high'],
    [{ inReplyTo: [] }, 'inReplyTo must be a string or null'],
    [{ references: '<m@example.com>' }, 'references must be an array'],
    [{ references: [42] }, 'references[0] must be a non-empty string'],
    [{ fromChanged: 1 }, 'fromChanged must be a boolean'],
  ])('rejects malformed patch input %#', (changes, message) => {
    expect(() => normalizeComposeChanges(changes)).toThrowError(
      expect.objectContaining({
        code: 'invalid_compose_changes',
        message,
        status: 400,
      }),
    );
  });

  it('validates nullable UUIDs and sanitizes message-id headers', () => {
    expect(normalizeComposeChanges({
      accountId: null,
      aliasId: '11111111-1111-4111-8111-111111111111',
      inReplyTo: '  <message@example.com>\r\n  ',
      references: [' <one@example.com> ', '<two@example.com>\0'],
      forwardedAttachments: [{
        messageId: '22222222-2222-4222-8222-222222222222',
        part: ' 2.1\r\n ',
      }],
    })).toEqual({
      accountId: null,
      aliasId: '11111111-1111-4111-8111-111111111111',
      inReplyTo: '<message@example.com>',
      references: ['<one@example.com>', '<two@example.com>'],
      forwardedAttachments: [{
        messageId: '22222222-2222-4222-8222-222222222222',
        part: '2.1',
      }],
    });
  });

  it.each([
    ['browser-a', 'browser-a'],
    ['A_1-opaque', 'A_1-opaque'],
    [undefined, undefined],
    [null, undefined],
    ['', undefined],
  ])('normalizes an opaque client id %#', (value, expected) => {
    expect(normalizeComposeClientId(value)).toBe(expected);
  });

  it.each([
    ['contains spaces'],
    ['person@example.com'],
    ['client.with.content'],
    ['x'.repeat(65)],
    [{}],
  ])('rejects malformed or content-bearing client ids %#', (value) => {
    expect(() => normalizeComposeClientId(value)).toThrowError(
      expect.objectContaining({ code: 'invalid_client_id', status: 400 }),
    );
  });

  it.each([
    [{ to: ['a@example.com'] }, true],
    [{ subject: 'x' }, true],
    [{ body: '<p>x</p>', bodyIsHtml: true }, true],
    [{ attachmentCount: 1 }, true],
    [{ mode: 'reply', inReplyTo: '<m@example.com>' }, true],
    [{ fromChanged: true }, true],
    [{ accountId: 'default-account', mode: 'new' }, false],
  ])('classifies meaningful state %#', (session, expected) => {
    expect(meaningfulComposeSession(session)).toBe(expected);
  });

  it('reports only fields changed after the caller revision', () => {
    expect(findComposeConflicts({ subject: 4, to: 2, body: 7 }, 3, ['subject', 'to']))
      .toEqual(['subject']);
  });
});
