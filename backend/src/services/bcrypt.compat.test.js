import { describe, expect, it } from 'vitest';
import bcrypt from 'bcryptjs';

// Password and PIN hashes in the database were written by bcryptjs 2 with the $2a$ prefix.
// bcryptjs 3 writes $2b$; both must keep verifying.
const LEGACY_2A_HASH = '$2a$10$JnhEbHIWQuSCK3CwZBjQBep6yKUc2QBJDVjgc2YXsj6GDYqt4H9Rq'; // "legacy-pass"

describe('bcryptjs hash compatibility', () => {
  it('verifies a $2a$ hash produced by bcryptjs 2', async () => {
    expect(await bcrypt.compare('legacy-pass', LEGACY_2A_HASH)).toBe(true);
    expect(await bcrypt.compare('wrong-pass', LEGACY_2A_HASH)).toBe(false);
  });

  it('round-trips a new hash', async () => {
    const hash = await bcrypt.hash('new-pass', 4);
    expect(hash.startsWith('$2b$04$')).toBe(true);
    expect(await bcrypt.compare('new-pass', hash)).toBe(true);
  });
});
