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

// The verdict value handed to the UPDATE that persists the classification.
function persistedVerdict() {
  const update = query.mock.calls.find(([sql]) => sql.includes('UPDATE messages SET'));
  return update ? update[1][0] : undefined;
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

describe('classifyAndTagMessage — scenario 3: borderline stays ham/unsure', () => {
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

  it('persists the ambiguous middle band as unsure (the schema vocabulary)', async () => {
    // A single 0.4-weight rule (AUTH_DKIM_FAIL, with spf/dmarc passing so no
    // other auth rule fires) lands in [0.3, 0.85): the persisted value must be
    // 'unsure' — the CHECK on messages.spam_verdict (migration 0021) allows
    // spam|ham|unsure|pending, and 'uncertain' would be rejected, silently
    // dropping the verdict on the UPDATE.
    getModelForUser.mockResolvedValue(null);
    query.mockResolvedValueOnce({ rows: [messageRow({ trusted_authserv_id: 'mx.example.com' })] });

    const result = await classifyAndTagMessage(MESSAGE_ID, {
      headers: ['Authentication-Results: mx.example.com; dkim=fail header.d=x.example;'
        + ' spf=pass smtp.mailfrom=x.example; dmarc=pass header.from=x.example'],
    });

    expect(result.verdict).toBe('unsure');
    expect(persistedVerdict()).toBe('unsure');
  });

  it('never writes a verdict outside the schema vocabulary', async () => {
    const ALLOWED = ['spam', 'ham', 'unsure', 'pending'];
    const cases = [
      { subject: 'CHEAP VIAGRA!!! BUY NOW', body_text: 'Click here, buy now, free pills, limited offer', from_email: 'a@spoof.net' },
      { subject: 'Meeting agenda', body_text: 'Please review the attached document.', from_email: 'b@corp.example' },
      { subject: 'Cheap offer today', body_text: 'Limited offer, buy now.', from_email: 'promo@shop.example' },
    ];
    for (const c of cases) {
      query.mockClear();
      query.mockResolvedValue({ rows: [messageRow(c)] });
      getModelForUser.mockResolvedValue(null);
      const result = await classifyAndTagMessage(MESSAGE_ID, {});
      expect(ALLOWED).toContain(result.verdict);
      expect(ALLOWED).toContain(persistedVerdict());
    }
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

describe('classifyAndTagMessage — Authentication-Results trust gate', () => {
  // A sender can inject their own Authentication-Results header. Fetch the real
  // MTA's header plus a forged all-pass one and check that only the trusted
  // authserv-id is honored (PR review, 2026-08-25).
  const FORGED = 'Authentication-Results: attacker.invalid; dkim=pass; spf=pass; dmarc=pass';
  const REAL = 'Authentication-Results: mx.example.com; dkim=fail header.d=spoof.com; spf=fail smtp.mailfrom=spoof.com';
  const headers = [FORGED, REAL];

  function persistedDetails() {
    const update = query.mock.calls.find(([sql]) => sql.includes('UPDATE messages SET'));
    return JSON.parse(update[1][2]);
  }

  it('honors the trusted header and ignores the forged pass', async () => {
    getModelForUser.mockResolvedValue(null); // rules-only: deterministic
    query.mockResolvedValueOnce({
      rows: [messageRow({ trusted_authserv_id: 'mx.example.com' })],
    });

    await classifyAndTagMessage(MESSAGE_ID, { headers });

    const details = persistedDetails();
    const fired = details.rulesFired.map(r => r.name);
    expect(fired).toContain('AUTH_DKIM_FAIL');
    expect(fired).toContain('AUTH_SPF_FAIL');
    expect(details.authservIds).toEqual(['attacker.invalid', 'mx.example.com']);
    expect(details.trustedAuthservId).toBe('mx.example.com');
    expect(details.authTrusted).toBe(true);
  });

  it('stays neutral when the account trusts no authserv-id (default)', async () => {
    getModelForUser.mockResolvedValue(null);
    query.mockResolvedValueOnce({ rows: [messageRow()] }); // trusted_authserv_id: null

    await classifyAndTagMessage(MESSAGE_ID, { headers });

    const details = persistedDetails();
    expect(details.rulesFired.map(r => r.name).some(n => n.startsWith('AUTH_'))).toBe(false);
    expect(details.trustedAuthservId).toBeNull();
    expect(details.authTrusted).toBe(false);
    // The ids actually seen are still recorded for the setup helper.
    expect(details.authservIds).toEqual(['attacker.invalid', 'mx.example.com']);
  });

  it('records no authserv-ids when the message carries none', async () => {
    getModelForUser.mockResolvedValue(null);
    query.mockResolvedValueOnce({ rows: [messageRow()] });

    await classifyAndTagMessage(MESSAGE_ID, { headers: ['Subject: hi'] });

    const details = persistedDetails();
    expect(details.authservIds).toEqual([]);
    expect(details.trustedAuthservId).toBeNull();
    expect(details.authTrusted).toBe(false);
  });
});

describe('autoMove — non-UIDPLUS destination guard (mirrors the manual /spam path)', () => {
  const spamMessage = {
    subject: 'CHEAP VIAGRA!!! WIN $$$',
    body_text: 'Click here. Buy now. Limited time offer, act now!',
    from_email: 'spammer@spoof.biz',
    replyTo: 'other@evil.com',
    attachments: [{ filename: 'invoice.exe' }],
  };

  it('guards the destination UID and keeps the stale source UID when the server has no UIDPLUS', async () => {
    vi.useFakeTimers();
    try {
      getModelForUser.mockResolvedValue(trainedModel(200));
      query.mockResolvedValueOnce({ rows: [messageRow(spamMessage)] });

      const imap = imapFacade();
      imap.moveMessage.mockResolvedValue(null); // non-UIDPLUS: no new UID returned

      const result = await classifyAndTagMessage(MESSAGE_ID, { imap });
      expect(result.moved).toBe(true);

      // Source guarded before the move, destination guarded after it.
      expect(imap._guardMoveUid).toHaveBeenCalledWith(ACCOUNT_ID, 'INBOX', 100);
      expect(imap._guardMoveUid).toHaveBeenCalledWith(ACCOUNT_ID, 'Junk', 100);

      // The row moves to the destination keeping the (stale) source UID.
      const update = query.mock.calls.find(
        ([sql]) => sql.includes('UPDATE messages SET folder = $1 WHERE id = $2'),
      );
      expect(update[1]).toEqual(['Junk', MESSAGE_ID]);
      // No re-keying UPDATE is issued on this branch.
      expect(query.mock.calls.some(
        ([sql]) => sql.includes('UPDATE messages SET folder = $1, uid = $2'),
      )).toBe(false);

      // The destination guard is held for the 10s grace period, then released.
      expect(imap._unguardMoveUid).not.toHaveBeenCalledWith(ACCOUNT_ID, 'Junk', 100);
      vi.advanceTimersByTime(10_000);
      expect(imap._unguardMoveUid).toHaveBeenCalledWith(ACCOUNT_ID, 'Junk', 100);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not guard the destination on a UIDPLUS move', async () => {
    getModelForUser.mockResolvedValue(trainedModel(200));
    query.mockResolvedValueOnce({ rows: [messageRow(spamMessage)] });

    const imap = imapFacade();
    imap.moveMessage.mockResolvedValue(500); // UIDPLUS: server re-keyed the message

    const result = await classifyAndTagMessage(MESSAGE_ID, { imap });
    expect(result.moved).toBe(true);

    expect(imap._guardMoveUid).toHaveBeenCalledWith(ACCOUNT_ID, 'INBOX', 100);
    expect(imap._guardMoveUid).not.toHaveBeenCalledWith(ACCOUNT_ID, 'Junk', 100);
    expect(imap._unguardMoveUid).not.toHaveBeenCalledWith(ACCOUNT_ID, 'Junk', 100);

    // The row is re-keyed to the UID the server assigned in the destination.
    const update = query.mock.calls.find(
      ([sql]) => sql.includes('UPDATE messages SET folder = $1, uid = $2'),
    );
    expect(update[1]).toEqual(['Junk', 500, MESSAGE_ID]);
  });
});

describe('classifyAndTagMessage — deferAutoMove (backfill path)', () => {
  // A message the model scores above the auto-move threshold, so the ONLY reason it
  // is not moved is the defer flag.
  const spamMessage = {
    subject: 'CHEAP VIAGRA!!! WIN $$$',
    body_text: 'Click here. Buy now. Limited time offer, act now!',
    from_email: 'spammer@spoof.biz',
    replyTo: 'other@evil.com',
    attachments: [{ filename: 'invoice.exe' }],
  };

  function persistedDetails() {
    const update = query.mock.calls.find(([sql]) => sql.includes('UPDATE messages SET'));
    return JSON.parse(update[1][2]);
  }

  it('tags without moving, keeping the verdict and the deferred intent', async () => {
    getModelForUser.mockResolvedValue(trainedModel(200));
    query.mockResolvedValueOnce({ rows: [messageRow(spamMessage)] });

    const imap = imapFacade();
    const result = await classifyAndTagMessage(MESSAGE_ID, { imap, deferAutoMove: true });

    expect(result.verdict).toBe('spam');
    expect(result.moved).toBe(false);
    expect(result.shouldMove).toBe(false);
    expect(result.autoMoveDeferred).toBe(true);
    expect(imap.moveMessage).not.toHaveBeenCalled();
    expect(imap._guardMoveUid).not.toHaveBeenCalled();

    // The verdict and the deferred intent are still persisted for the badge/explain.
    const update = query.mock.calls.find(([sql]) => sql.includes('UPDATE messages SET'));
    expect(update[1][0]).toBe('spam');
    expect(persistedDetails().autoMoveDeferred).toBe(true);
  });

  it('does not claim a deferred move for a message that was never eligible', async () => {
    getModelForUser.mockResolvedValue(trainedModel(200));
    query.mockResolvedValueOnce({ rows: [messageRow({ ...spamMessage, folder_mappings: {} })] });

    const result = await classifyAndTagMessage(MESSAGE_ID, { imap: imapFacade(), deferAutoMove: true });

    expect(result.verdict).toBe('spam');
    expect(result.autoMoveDeferred).toBe(false); // no spam folder configured
    expect(persistedDetails().autoMoveDeferred).toBe(false);
  });

  it('still moves on normal ingest, and records no deferred intent', async () => {
    getModelForUser.mockResolvedValue(trainedModel(200));
    query.mockResolvedValueOnce({ rows: [messageRow(spamMessage)] });

    const imap = imapFacade();
    const result = await classifyAndTagMessage(MESSAGE_ID, { imap });

    expect(result.shouldMove).toBe(true);
    expect(result.moved).toBe(true);
    expect(result.autoMoveDeferred).toBe(false);
    expect(imap.moveMessage).toHaveBeenCalledTimes(1);
    expect(persistedDetails().autoMoveDeferred).toBe(false);
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