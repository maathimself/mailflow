import { describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({ query: vi.fn() }));
vi.mock('../index.js', () => ({ imapManager: {} }));

import { isProtectedDestination, providerSkipsFolder } from './apiTokenDestinations.js';
import { providerProfile } from './imapManager.js';

const gmail = providerProfile({ imap_host: 'imap.gmail.com' });
const generic = providerProfile({ imap_host: 'mail.example.com' });
const ordinary = { noSelect: false, specialUse: null, trash: false, drafts: false, spam: false, snoozed: false };
const isProtected = (path, roles = {}, profile = generic) => isProtectedDestination(path, { ...ordinary, ...roles }, profile);

describe('where an API token may not move mail', () => {
  it('lets an ordinary folder through, Archive and Sent included', () => {
    for (const path of ['Archive', 'Receipts', 'INBOX', 'INBOX/Clients', 'Sent', '[Gmail]/Sent Mail']) {
      expect(isProtected(path, {}, path.startsWith('[Gmail]') ? gmail : generic), path).toBe(false);
    }
    expect(isProtected('Archive', { specialUse: '\\Archive' })).toBe(false);
    expect(isProtected('Sent', { specialUse: '\\Sent' })).toBe(false);
  });

  it('a folder that cannot hold mail', () => {
    expect(isProtected('[Gmail]', { noSelect: true })).toBe(true);
  });

  it.each(['\\Trash', '\\Junk', '\\Drafts', '\\All', '\\Flagged', '\\trash', '\\JUNK'])('a folder flagged %s', (specialUse) => {
    expect(isProtected('Whatever it is called', { specialUse })).toBe(true);
  });

  it('the Snoozed folder, where a message moved by hand never wakes', () => {
    expect(isProtected('Snoozed')).toBe(true);
    // INBOX.Snoozed under an INBOX. namespace prefix, which folderRoles knows by its name.
    expect(isProtected('INBOX.Snoozed', { snoozed: true })).toBe(true);
    // A folder of the user's own that only looks like it is not the snooze folder.
    expect(isProtected('Projects/Snoozed')).toBe(false);
  });

  it('a folder the Trash, Drafts or Spam rules or mappings make one, whatever its flags', () => {
    expect(isProtected('Deleted Messages', { trash: true })).toBe(true);
    expect(isProtected('Entwürfe', { drafts: true })).toBe(true);
    expect(isProtected('Bulk Mail', { spam: true })).toBe(true);
  });

  it.each(['[Gmail]/All Mail', '[Gmail]/Starred', '[Gmail]/Important', '[Google Mail]/All Mail', '[gmail]/important'])(
    'a Gmail folder MailFlow does not sync: %s',
    (path) => {
      expect(isProtected(path, {}, gmail)).toBe(true);
    },
  );

  it('the skip list is the provider\'s own, as imapManager.js uses it', () => {
    expect(providerSkipsFolder(gmail, '[Gmail]')).toBe(true);
    expect(providerSkipsFolder(gmail, '[Gmail]/Drafts')).toBe(false);
    // Other providers sync a folder called Important.
    expect(providerSkipsFolder(generic, '[Gmail]/Important')).toBe(false);
    expect(isProtected('Important', {}, generic)).toBe(false);
  });
});
