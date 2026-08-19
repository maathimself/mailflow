import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('./spamModelStore.js', () => ({ getModelForUser: vi.fn() }));

import { query } from './db.js';
import { getModelForUser } from './spamModelStore.js';
import {
  classifyAndTagMessage,
  SPAM_THRESHOLD,
  AUTO_MOVE_THRESHOLD,
  MIN_TRAINING_RECORDS,
} from './spamPipeline.js';
import { createEmptyModel, updateIncremental } from './spamModel.js';

const ACCOUNT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_ID = 'uuuuuuuu-uuuu-4uuu-8uuu-uuuuuuuuuuuu';
const MESSAGE_ID = 'mmmmmmmm-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function messageRow(overrides = {}) {
  return {
    id: MESSAGE_ID,
    account_id: ACCOUNT_ID,
    owner_id: USER_ID,
    account_email: 'user@example.com',
    antispam_enabled: 1,
    folder_mappings: { spam: 'Junk' },
    folder: 'INBOX',
    uid: 100,
    message_id: '<msg-1@example.com>',
    subject: 'Hello',
    body_text: 'A normal message.',
    body_html: null,
    from_email: 'sender@example.com',
    attachments: [],
    spam_user_override: null,
    spam_verdict: null,
    spam_analyzed_at: null,
    ...overrides,
  };
}

// Build a trained model with the given record count using discriminated words.
function trainedModel(records) {
  let model = createEmptyModel();
  const spamWords = ['cheap', 'viagra', 'click', 'buy', 'offer', 'free'];
  const hamWords = ['meeting', 'agenda', 'notes', 'review', 'document', 'thanks'];
  for (let i = 0; i < records; i += 1) {
    const isSpam = i % 2 === 0;
    const words = isSpam ? spamWords : hamWords;
    model = updateIncremental(model, words, {}, isSpam ? 'spam' : 'ham');
  }
  return model;
}

function imapFacade() {
  return {
    moveMessage: vi.fn().mockResolvedValue(200),
    broadcast: vi.fn(),
    _guardMoveUid: vi.fn(),
    _unguardMoveUid: vi.fn(),
  };
}

beforeEach(() => {
  query.mockReset();
  getModelForUser.mockReset();
  query.mockResolvedValue({ rows: [] });
});

describe('classifyAndTagMessage — gate rules', () => {
  it('skips when the user already overrode the verdict', async () => {
    query.mockResolvedValueOnce({ rows: [messageRow({ spam_user_override: 'ham' })] });
    const result = await classifyAndTagMessage(MESSAGE_ID, {});
    expect(result).toEqual({ skipped: 'user_override' });
  });

  it('skips when the account toggle is off', async () => {
    query.mockResolvedValueOnce({ rows: [messageRow({ antispam_enabled: 0 })] });
    const result = await classifyAndTagMessage(MESSAGE_ID, {});
    expect(result).toEqual({ skipped: 'antispam_disabled' });
  });

  it('skips when the per-user master switch is off', async () => {
    query.mockResolvedValueOnce({
      rows: [messageRow({ master_spam_enabled: 'false' })],
    });
    const result = await classifyAndTagMessage(MESSAGE_ID, {});
    expect(result).toEqual({ skipped: 'spam_disabled' });
  });

  it('returns null for an unknown message', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await expect(classifyAndTagMessage(MESSAGE_ID, {})).resolves.toBeNull();
  });
});

describe('classifyAndTagMessage — scenario: fresh install (0 records)', () => {
  it('tags with the rules verdict but NEVER auto-moves before 50 records', async () => {
    getModelForUser.mockResolvedValue(null); // no model → rules-only
    query.mockResolvedValueOnce({
      rows: [messageRow({
        subject: 'CHEAP VIAGRA!!!',
        from: 'spam@spoof.net',
        replyTo: 'other@evil.com',
        attachments: [{ filename: 'invoice.pdf.exe' }],
      })],
    });

    const imap = imapFacade();
    const result = await classifyAndTagMessage(MESSAGE_ID, { imap });

    expect(result.verdict).toBe('spam'); // rules score 1.0 clamps
    expect(result.method).toBe('rules');
    expect(result.mlProbability).toBeNull();
    expect(result.shouldMove).toBe(false); // rules-only never moves
    expect(result.moved).toBe(false);
    expect(imap.moveMessage).not.toHaveBeenCalled();

    // Verdict was persisted.
    const update = query.mock.calls.find(([sql]) => sql.includes('UPDATE messages SET'));
    expect(update[0]).toContain('spam_verdict');
    expect(update[1][0]).toBe('spam');
    expect(JSON.parse(update[1][2])).toMatchObject({ method: 'rules' });
  });
});

describe('classifyAndTagMessage — scenario 2: active user moves spam', () => {
  it('blends rules + ML and auto-moves on very high confidence', async () => {
      getModelForUser.mockResolvedValue(trainedModel(200));
      query.mockResolvedValueOnce({
        rows: [messageRow({
          subject: 'CHEAP VIAGRA!!! WIN $$$',
          body_text: 'Click here. Buy now. Limited time offer, act now!',
          from_email: 'spammer@spoof.biz',
          replyTo: 'other@evil.com',
          attachments: [{ filename: 'invoice.exe' }],
        })],
      });

      const imap = imapFacade();
      const result = await classifyAndTagMessage(MESSAGE_ID, { imap });

      expect(result.verdict).toBe('spam');
      expect(result.method).toBe('blended');
      expect(result.blendedScore).toBeGreaterThanOrEqual(AUTO_MOVE_THRESHOLD);
      expect(result.shouldMove).toBe(true);
      expect(result.moved).toBe(true);
      expect(imap.moveMessage).toHaveBeenCalledWith(
        expect.objectContaining({ id: ACCOUNT_ID }),
        100, 'INBOX', 'Junk',
      );
    });

  it('does NOT move when the folder_mappings.spam is unconfigured', async () => {
    getModelForUser.mockResolvedValue(trainedModel(200));
    query.mockResolvedValueOnce({
      rows: [messageRow({
        folder_mappings: {},
        subject: 'Cheap Viagra!',
        body_text: 'Buy now, limited time, act now, click here, free money',
      })],
    });

    const imap = imapFacade();
    const result = await classifyAndTagMessage(MESSAGE_ID, { imap });
    expect(result.verdict).toBe('spam');
    expect(result.shouldMove).toBe(false);
    expect(imap.moveMessage).not.toHaveBeenCalled();
  });
});

describe('classifyAndTagMessage — scenario 3: borderline stays ham/uncertain', () => {
  it('does not flag a normal message', async () => {
    getModelForUser.mockResolvedValue(trainedModel(200));
    query.mockResolvedValueOnce({
      rows: [messageRow({
        subject: 'Meeting agenda',
        body_text: 'Please review the attached document and send your notes.',
      })],
    });

    const imap = imapFacade();
    const result = await classifyAndTagMessage(MESSAGE_ID, { imap });
    expect(result.verdict).toBe('ham');
    expect(result.shouldMove).toBe(false);
    expect(imap.moveMessage).not.toHaveBeenCalled();
  });
});

describe('classifyAndTagMessage — scenario 5: blend weights shift with training', () => {
  it('uses rules-only below 50, 60/40 at 100, 20/80 above 500', async () => {
    // Zero records: rules only.
    getModelForUser.mockResolvedValue(null);
    query.mockResolvedValueOnce({ rows: [messageRow({ subject: 'Cheap Viagra', body_text: '' })] });
    const r0 = await classifyAndTagMessage(MESSAGE_ID, {});
    expect(r0.method).toBe('rules');
    expect(r0.blendedScore).toBe(r0.blendedScore); // rules score only

    // 100 records: blended 60/40.
    getModelForUser.mockResolvedValue(trainedModel(100));
    query.mockResolvedValueOnce({ rows: [messageRow({ subject: 'Cheap Viagra', body_text: '' })] });
    const r100 = await classifyAndTagMessage(MESSAGE_ID, {});
    expect(r100.method).toBe('blended');
    expect(r100.mlProbability).not.toBeNull();

    // 600 records: blended 20/80.
    getModelForUser.mockResolvedValue(trainedModel(600));
    query.mockResolvedValueOnce({ rows: [messageRow({ subject: 'Cheap Viagra', body_text: '' })] });
    const r600 = await classifyAndTagMessage(MESSAGE_ID, {});
    expect(r600.method).toBe('blended');
  });

  it('exposes the documented threshold constants', () => {
    expect(SPAM_THRESHOLD).toBe(0.85);
    expect(AUTO_MOVE_THRESHOLD).toBe(0.95);
    expect(MIN_TRAINING_RECORDS).toBe(50);
  });
});

describe('classifyAndTagMessage — auto-move failure does not throw', () => {
  it('logs and keeps the verdict when the IMAP move fails', async () => {
      getModelForUser.mockResolvedValue(trainedModel(200));
      query.mockResolvedValueOnce({
        rows: [messageRow({
          subject: 'CHEAP VIAGRA!!!',
          body_text: 'Click here now buy now, limited time offer, act now',
          from_email: 'spammer@spoof.biz',
          replyTo: 'other@evil.com',
          attachments: [{ filename: 'invoice.exe' }],
        })],
      });

      const imap = imapFacade();
      imap.moveMessage.mockRejectedValue(new Error('IMAP down'));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const result = await classifyAndTagMessage(MESSAGE_ID, { imap });
      expect(result.verdict).toBe('spam');
      expect(result.moved).toBe(false);
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });
});