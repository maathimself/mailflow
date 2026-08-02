import { createHash, randomUUID as defaultRandomUUID } from 'crypto';
import { runTransitionsForSentMessage as defaultRunTransitionsForSentMessage } from '../gtdTransitions.js';
import { parseAddress } from './addresses.js';
import { redactEmail } from '../../utils/redact.js';
import { generateVCard as defaultGenerateVCard } from '../../utils/vcard.js';

const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function resolveSentFolder(account, deps) {
  const mapped = account.folder_mappings?.sent;
  if (mapped) return mapped;
  const result = await deps.query(
    "SELECT path FROM folders WHERE account_id = $1 AND special_use = '\\Sent' LIMIT 1",
    [account.id],
  );
  return result.rows[0]?.path || null;
}

export function scheduleSentMetadataUpsert(account, sentFolder, mailOptions, meta, deps) {
  if (!sentFolder || !mailOptions.messageId) return;
  const defer = deps.defer || setImmediate;
  const sleep = deps.sleep || defaultSleep;
  defer(async () => {
    for (const delay of [3000, 10000, 20000]) {
      await sleep(delay);
      try {
        const uid = await deps.imapManager.findUidByMessageId(account, sentFolder, mailOptions.messageId);
        if (uid) {
          await deps.imapManager.upsertSentMessageRecord(account, sentFolder, uid, meta);
          return;
        }
      } catch (err) {
        console.warn('Post-send sent metadata upsert failed:', err.message);
      }
    }
  });
}

export async function persistSentCopy({
  account,
  sentFolder,
  rawMessage,
  mailOptions,
  meta,
}, deps) {
  if (!sentFolder) return { sentCopySaved: null };
  const { imapManager } = deps;
  const runTransitionsForSentMessage = deps.runTransitionsForSentMessage || defaultRunTransitionsForSentMessage;

  if (rawMessage) {
    // Non-auto-saving account: APPEND the Sent copy ourselves — exactly ONCE. IMAP
    // APPEND is NOT idempotent (unlike a \Seen flag), so we must not retry: a retry
    // whose first attempt merely timed out (but still lands on the server) would store
    // a SECOND copy. Bound the wait so a stalled connection can't hang the response;
    // the abandoned append can at worst still save the single copy. On failure, warn
    // the user and schedule a fallback sync in case the append landed late. Audit [2].
    let sentCopySaved = false;
    try {
      const { uid } = await Promise.race([
        imapManager.appendToSent(account, sentFolder, rawMessage),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Sent APPEND timed out')), 20000)),
      ]);
      sentCopySaved = true;
      if (uid && meta) {
        await imapManager.upsertSentMessageRecord(account, sentFolder, uid, meta)
          .catch(err => console.warn('Sent metadata upsert failed:', err.message));
      }
      setTimeout(() => {
        imapManager.syncFolderOnDemand(account, sentFolder)
          // Once the Sent copy is in the DB, re-run GTD transitions for its thread: a reply
          // to a Todo/Someday thread means the owner acted, so that label should drop. The
          // sent message reaches no other GTD hook (Sent isn't INBOX, and the tick watches
          // only the state folders), so this is the only trigger. Swallow on failure — the
          // next inbound sync / GTD tick self-heals.
          .then(() => runTransitionsForSentMessage(imapManager, account, mailOptions.messageId)
            .catch(error => console.warn(`Post-append GTD transition failed: ${error.message}`)))
          .catch(error => console.error(`Post-append sync failed: ${error.message}`));
      }, 1000);
    } catch (appendErr) {
      console.error(`IMAP append to Sent failed for ${redactEmail(account.email_address)}/${sentFolder}: ${appendErr.message}`);
      // The append may still have landed (or land shortly) — pull the folder so a
      // late-completing append self-corrects the DB rather than staying invisible.
      setTimeout(() => {
        imapManager.syncFolderOnDemand(account, sentFolder)
          .catch(error => console.error(`Post-append fallback sync failed: ${error.message}`));
      }, 8000);
    }
    return { sentCopySaved };
  }

  // Server auto-saves via SMTP; seed metadata once the Sent copy is searchable.
  if (meta) scheduleSentMetadataUpsert(account, sentFolder, mailOptions, meta, deps);
  // Server auto-saves via SMTP; just sync after a delay. Two attempts because the
  // provider (e.g. Gmail) can be slow to expose the sent message; the 3s pass usually
  // catches it, the 15s pass is the safety net. GTD transitions run after each: the 3s
  // attempt may miss (Sent copy not yet visible → empty thread set → no-op) and the 15s
  // attempt then catches it; if 3s already stripped, 15s is an idempotent no-op.
  const syncAttempt = label => imapManager.syncFolderOnDemand(account, sentFolder)
    .then(() => {
      console.log(`Post-send ${label} sync done: ${redactEmail(account.email_address)}/${sentFolder}`);
      return runTransitionsForSentMessage(imapManager, account, mailOptions.messageId)
        .catch(error => console.warn(`Post-send ${label} GTD transition failed: ${error.message}`));
    })
    .catch(error => console.error(`Post-send ${label} sync failed: ${error.message}`));
  setTimeout(() => syncAttempt('3s'), 3000);
  setTimeout(() => syncAttempt('15s'), 15000);
  return { sentCopySaved: null };
}

export function learnSentRecipients({ userId, recipients }, deps) {
  if (!recipients.length) return;
  const defer = deps.defer || setImmediate;
  const makeRandomUUID = deps.randomUUID || defaultRandomUUID;
  const generateVCard = deps.generateVCard || defaultGenerateVCard;
  const now = deps.now ? deps.now() : new Date();

  defer(async () => {
    try {
      // Ensure the user's default address book exists
      const abResult = await deps.query(
        `INSERT INTO address_books (user_id, name) VALUES ($1, 'Personal')
         ON CONFLICT (user_id, name) DO UPDATE SET updated_at = NOW()
         RETURNING id`,
        [userId],
      );
      const addressBookId = abResult.rows[0].id;

      const results = await Promise.allSettled(recipients.map(addr => {
        const { name, email } = parseAddress(addr);
        if (!email) return Promise.resolve();
        const primaryEmail = email.toLowerCase();
        const displayName = name || primaryEmail;
        const uid = makeRandomUUID();
        const emails = [{ value: primaryEmail, type: 'other', primary: true }];
        const vcard = generateVCard({ uid, displayName, emails });
        const etag = createHash('md5').update(vcard).digest('hex');
        // Upsert by (user_id, primary_email) — bump send_count and promote from is_auto.
        // On conflict, preserve an existing vcard; only fill it in if the row had none.
        return deps.query(`
          INSERT INTO contacts (
            address_book_id, user_id, uid, vcard, etag,
            display_name, primary_email, emails, is_auto, send_count, last_sent
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, false, 1, $9)
          ON CONFLICT (address_book_id, primary_email) WHERE primary_email IS NOT NULL DO UPDATE
            SET send_count   = contacts.send_count + 1,
                last_sent    = $9,
                is_auto      = false,
                display_name = CASE WHEN contacts.is_auto THEN $6 ELSE contacts.display_name END,
                vcard        = COALESCE(contacts.vcard, EXCLUDED.vcard),
                etag         = COALESCE(contacts.etag,  EXCLUDED.etag),
                updated_at   = NOW()
          RETURNING address_book_id
        `, [addressBookId, userId, uid, vcard, etag, displayName, primaryEmail, JSON.stringify(emails), now]);
      }));

      const failed = results.filter(result => result.status === 'rejected');
      if (failed.length) console.warn('Contact upsert errors:', failed.map(result => result.reason?.message));

      // Collect distinct address books actually modified (contacts may live in non-default books).
      const booksToSync = new Set();
      for (const result of results) {
        if (result.status === 'fulfilled' && result.value?.rows?.[0]?.address_book_id) {
          booksToSync.add(result.value.rows[0].address_book_id);
        }
      }
      if (!booksToSync.size) booksToSync.add(addressBookId);

      await Promise.all([...booksToSync].map(bookId =>
        deps.query('UPDATE address_books SET sync_token = gen_random_uuid()::text, updated_at = NOW() WHERE id = $1', [bookId])
      ));
    } catch (err) {
      console.warn('Contact upsert setup error:', err.message);
    }
  });
}
