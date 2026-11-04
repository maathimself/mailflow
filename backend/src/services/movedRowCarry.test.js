// A row a move dropped waits for the destination's sync, which puts its state back (#665 follow-up).
import { beforeEach, describe, expect, it } from 'vitest';
import { CARRY_MS, carryUpdate, clearCarries, hasCarries, rememberDroppedRows, takeCarry } from './movedRowCarry.js';

const ACC = 'acc-1';
const row = (over = {}) => ({
  account_id: ACC, message_id: '<m1@x>', date: '2026-11-04T10:00:00.000Z',
  spam_user_override: null, spam_verdict: 'spam', category: 'promotions', subject: 'not carried', ...over,
});

describe('movedRowCarry', () => {
  beforeEach(() => clearCarries());

  it('hands the destination sync what only MailFlow knew, once', () => {
    rememberDroppedRows('INBOX', [row()], { spam_user_override: 'ham', spam_verdict: 'ham' });
    expect(hasCarries()).toBe(true);
    const carried = takeCarry(ACC, 'INBOX', '<m1@x>', new Date('2026-11-04T10:00:00Z'));
    expect(carried).toEqual({ spam_user_override: 'ham', spam_verdict: 'ham', category: 'promotions' });
    expect(takeCarry(ACC, 'INBOX', '<m1@x>', new Date('2026-11-04T10:00:00Z'))).toBeNull();
  });

  it('is found only in the destination, in the same account', () => {
    rememberDroppedRows('Archive', [row()]);
    expect(takeCarry(ACC, 'INBOX', '<m1@x>', '2026-11-04T10:00:00Z')).toBeNull();
    expect(takeCarry('acc-2', 'Archive', '<m1@x>', '2026-11-04T10:00:00Z')).toBeNull();
    expect(takeCarry(ACC, 'Archive', '<m1@x>', '2026-11-04T10:00:00Z')).not.toBeNull();
  });

  it('leaves a different message with the same Message-ID alone', () => {
    rememberDroppedRows('INBOX', [row()]);
    expect(takeCarry(ACC, 'INBOX', '<m1@x>', '2026-11-05T10:00:00Z')).toBeNull();
    // Still there for the real copy.
    expect(takeCarry(ACC, 'INBOX', '<m1@x>', '2026-11-04T10:00:00.400Z')).not.toBeNull();
  });

  it('keeps each copy of a message moved together, one per copy the sync files', () => {
    rememberDroppedRows('Trash', [row({ category: 'social' }), row({ category: null })]);
    const first = takeCarry(ACC, 'Trash', '<m1@x>', '2026-11-04T10:00:00Z');
    const second = takeCarry(ACC, 'Trash', '<m1@x>', '2026-11-04T10:00:00Z');
    expect([first.category, second.category]).toEqual(['social', null]);
    expect(takeCarry(ACC, 'Trash', '<m1@x>', '2026-11-04T10:00:00Z')).toBeNull();
    expect(hasCarries()).toBe(false);
  });

  it('keeps nothing for a row with no Message-ID', () => {
    rememberDroppedRows('INBOX', [row({ message_id: null })]);
    expect(hasCarries()).toBe(false);
  });

  it('lets go after the carry window', () => {
    const now = Date.now();
    rememberDroppedRows('INBOX', [row()], {}, now);
    expect(takeCarry(ACC, 'INBOX', '<m1@x>', '2026-11-04T10:00:00Z', now + CARRY_MS + 1)).toBeNull();
    expect(hasCarries()).toBe(false);
  });

  it('builds the UPDATE that puts the columns back', () => {
    const u = carryUpdate('row-1', { spam_user_override: 'ham', spam_details: { a: 1 }, plugin_annotations: null, bcc_addresses: [{ email: 'b@x' }] });
    expect(u.text).toBe('UPDATE messages SET spam_details = $2::jsonb, spam_user_override = $3, plugin_annotations = COALESCE($4::jsonb, plugin_annotations), bcc_addresses = $5::jsonb WHERE id = $1');
    expect(u.params).toEqual(['row-1', '{"a":1}', 'ham', null, '[{"email":"b@x"}]']);
    expect(carryUpdate('row-1', {})).toBeNull();
    expect(carryUpdate('row-1', { subject: 'x' })).toBeNull();
  });

  it('carries a column the row did not load as absent, not as null', () => {
    rememberDroppedRows('INBOX', [{ account_id: ACC, message_id: '<m2@x>', date: null, category: 'social' }]);
    expect(takeCarry(ACC, 'INBOX', '<m2@x>', '2026-11-04T10:00:00Z')).toEqual({ category: 'social' });
  });
});
