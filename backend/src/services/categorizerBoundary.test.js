import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('./aiProvider.js', () => ({ completeText: vi.fn() }));

import { query } from './db.js';
import { backfillCategories, invalidateSocialDomainCache } from './categorizer.js';

describe('categorizer mutation boundary', () => {
  beforeEach(() => {
    query.mockReset();
    invalidateSocialDomainCache('user-1');
  });

  it('fails the whole category write when one frozen row snapshot is superseded', async () => {
    query.mockImplementation(async sql => {
      if (sql.includes('FROM category_list_sources')) return { rows: [] };
      if (sql.includes('SELECT m.id, m.from_email, m.is_bulk')) {
        return { rows: [{
          id: '00000000-0000-4000-8000-000000000001',
          account_id: 'acct-1', uid: 7, folder: 'INBOX',
          from_email: 'news@example.com', is_bulk: true,
          read_revision: 3, star_revision: 5,
          folder_uid_validity: 101, folder_observation_generation: 9,
        }] };
      }
      if (sql.includes('UPDATE messages')) return { rows: [], rowCount: 0 };
      throw new Error(`Unexpected query: ${sql}`);
    });

    await expect(backfillCategories('acct-1', 'user-1'))
      .rejects.toMatchObject({ code: 'MESSAGE_SNAPSHOT_SUPERSEDED' });

    const select = query.mock.calls.find(([sql]) => sql.includes('SELECT m.id'));
    expect(select[0]).toMatch(/m\.account_id[\s\S]*m\.uid[\s\S]*m\.folder/);
    expect(select[0]).toMatch(/m\.read_revision[\s\S]*m\.star_revision/);
    expect(select[0]).toMatch(/folder_uid_validity[\s\S]*folder_observation_generation/);

    const update = query.mock.calls.find(([sql]) => sql.includes('UPDATE messages'));
    expect(update[0]).toMatch(/jsonb_to_recordset/);
    expect(update[0]).toMatch(/m\.uid = desired\.uid[\s\S]*m\.folder = desired\.folder/);
    expect(update[0]).toMatch(/m\.read_revision = desired\.read_revision/);
    expect(update[0]).toMatch(/m\.star_revision = desired\.star_revision/);
    expect(update[0]).toMatch(/f\.uid_validity = desired\.uid_validity/);
    expect(update[0]).toMatch(/f\.observation_generation = desired\.folder_generation/);
    expect(update[0]).toMatch(/m\.is_deleted = false[\s\S]*m\.metadata_complete = true/);
  });
});
