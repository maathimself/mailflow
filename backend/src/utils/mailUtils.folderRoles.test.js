import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/db.js', () => ({ query: vi.fn() }));

import { query } from '../services/db.js';
import { folderRoles, resolveAllDraftsPaths, resolveAllSpamPaths, resolveAllTrashPaths } from './mailUtils.js';

const ACCOUNT = 'a1a1a1a1-1111-4111-8111-a1a1a1a1a1a1';
const squash = sql => sql.replace(/\s+/g, ' ').trim();

// The condition a resolver selects folders by, as it sends it to the database.
async function resolverCondition(resolver) {
  query.mockReset().mockResolvedValue({ rows: [] });
  await resolver(ACCOUNT, {});
  const sql = squash(query.mock.calls[0][0]);
  return sql.slice(sql.indexOf(' AND ') + 5);
}

async function rolesSql() {
  query.mockReset().mockResolvedValue({ rows: [] });
  await folderRoles(ACCOUNT, 'Trash');
  return { sql: squash(query.mock.calls[0][0]), params: query.mock.calls[0][1] };
}

beforeEach(() => query.mockReset());

describe('folderRoles', () => {
  it('decides Trash, Drafts and Spam by the very conditions the resolvers use', async () => {
    const { sql, params } = await rolesSql();
    for (const resolver of [resolveAllTrashPaths, resolveAllDraftsPaths, resolveAllSpamPaths]) {
      const condition = await resolverCondition(resolver);
      expect(condition.length, resolver.name).toBeGreaterThan(20);
      expect(sql, resolver.name).toContain(condition);
    }
    expect(params).toEqual([ACCOUNT, 'Trash']);
  });

  it('also counts a folder the account maps as Trash, Drafts or Spam, usable or not', async () => {
    const { sql } = await rolesSql();
    for (const role of ['trash', 'drafts', 'spam']) expect(sql).toContain(`folder_mappings->>'${role}'`);
  });

  it('knows Snoozed by its name where the snooze route creates it, or by a snooze record of the account', async () => {
    const { sql } = await rolesSql();
    // At the top level, or directly under INBOX as an INBOX. namespace prefix puts it: the stock
    // Trash and Drafts names' rule. 'Projects/Snoozed' is the user's own.
    expect(sql).toContain("lower(name) = 'snoozed' AND (path = name OR upper(path) = ('INBOX' || delimiter || upper(name)))");
    // Any other prefix, or where a rename took it, while mail waits there.
    expect(sql).toContain('EXISTS (SELECT 1 FROM snoozed_messages sm WHERE sm.account_id = $1 AND sm.snoozed_folder = $2)');
  });

  it('unions each rule with its mapping', async () => {
    const row = over => ({ no_select: false, special_use: null, trash_rule: false, drafts_rule: false, spam_rule: false,
      mapped_trash: false, mapped_drafts: false, mapped_spam: false, snoozed_rule: false, snooze_record: false, ...over });
    const cases = [
      [{}, { trash: false, drafts: false, spam: false, snoozed: false }],
      [{ trash_rule: true }, { trash: true }],
      [{ mapped_trash: true }, { trash: true }],
      [{ drafts_rule: true }, { drafts: true }],
      [{ mapped_drafts: true }, { drafts: true }],
      [{ spam_rule: true }, { spam: true }],
      [{ mapped_spam: true }, { spam: true }],
      [{ snoozed_rule: true }, { snoozed: true }],
      [{ snooze_record: true }, { snoozed: true }],
      [{ no_select: true, special_use: '\\All' }, { noSelect: true, specialUse: '\\All' }],
    ];
    for (const [over, expected] of cases) {
      query.mockResolvedValueOnce({ rows: [row(over)] });
      expect(await folderRoles(ACCOUNT, 'X'), JSON.stringify(over)).toMatchObject(expected);
    }
  });

  it('is null for a folder the account does not have', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    expect(await folderRoles(ACCOUNT, 'Nowhere')).toBe(null);
  });
});
