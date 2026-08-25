import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const migration = readFileSync(
  new URL('../../migrations/0051_folder_backfill_incomplete.sql', import.meta.url),
  'utf8'
);
const imapManagerSource = readFileSync(new URL('./imapManager.js', import.meta.url), 'utf8');
const mailRoutesSource = readFileSync(new URL('../routes/mail.js', import.meta.url), 'utf8');

describe('legacy metadata completeness migration', () => {
  it('matches the empty-string snippet shape persisted by the old UID-only parser', () => {
    expect(migration).toMatch(/COALESCE\(snippet,\s*''\)\s*=\s*''/);
  });

  it('does not require an empty from_email because Sent enrichment populated it', () => {
    const legacyUpdate = migration.match(/UPDATE messages[\s\S]*?;/)?.[0] || '';
    expect(legacyUpdate).not.toMatch(/COALESCE\(from_email/);
    expect(legacyUpdate).not.toMatch(/COALESCE\(from_name/);
  });

  it('excludes unverified rows from the push-notification unread badge', () => {
    const pushCount = imapManagerSource.match(/Try to include the total unread count[\s\S]*?\.then\(r =>/)?.[0] || '';
    expect(pushCount).toContain('m.metadata_complete = true');
  });

  it('excludes unverified and deleted rows from mailbox cleanup reads', () => {
    const start = mailRoutesSource.indexOf("router.get('/mailbox-usage'");
    const end = mailRoutesSource.indexOf("router.post('/messages/bulk-move'", start);
    const cleanup = mailRoutesSource.slice(start, end);
    expect(cleanup.match(/metadata_complete = true/g)).toHaveLength(4);
    expect(cleanup.match(/is_deleted = false/g)).toHaveLength(4);
  });

  it('rejects unverified and deleted rows from body and raw-header reads', () => {
    const bodyStart = mailRoutesSource.indexOf("router.get('/messages/:id/body'");
    const headersStart = mailRoutesSource.indexOf("router.get('/messages/:id/headers'");
    const bodyRoute = mailRoutesSource.slice(bodyStart, headersStart);
    const headersRoute = mailRoutesSource.slice(headersStart, mailRoutesSource.indexOf("router.get('/messages/:id/attachments", headersStart));
    for (const route of [bodyRoute, headersRoute]) {
      expect(route).toContain('m.is_deleted = false');
      expect(route).toContain('m.metadata_complete = true');
    }
  });

  it('fully replaces manufactured legacy metadata before marking a conflict complete', () => {
    const required = [
      'message_id', 'date', 'has_attachments', 'attachments', 'subject',
      'from_name', 'from_email', 'to_addresses', 'cc_addresses', 'reply_to',
      'in_reply_to', 'snippet', 'flags', 'thread_references', 'thread_id',
    ];
    for (const field of required) {
      expect(imapManagerSource).toMatch(new RegExp(
        `${field}\\s*=\\s*CASE\\s+WHEN NOT messages\\.metadata_complete\\s+THEN EXCLUDED\\.${field}`
      ));
    }
    expect(imapManagerSource.match(/\$\{COMPLETE_METADATA_CONFLICT_UPDATE_SQL\}/g)).toHaveLength(2);
  });
});
