import nodemailer from 'nodemailer';
import { randomBytes } from 'crypto';
import { Router } from 'express';
import { query } from '../services/db.js';
import { requireAuth } from '../middleware/auth.js';
import sanitizeHtml from 'sanitize-html';
import { sanitizeSignature, sanitizeComposeBody, sanitizeEmail } from '../services/emailSanitizer.js';
import { embedInlineDataImages } from '../utils/inlineImages.js';
import { imapManager } from '../index.js';
import { resolveAllDraftsPaths } from '../utils/mailUtils.js';
import { draftFolderPaths, createReplyGraph, replyChainIdsFor, indexReplyDrafts, createReplyDraftIndex, headerIds } from '../services/replyDraftLookup.js';

const router = Router();
router.use(requireAuth);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_REPLY_CONVERSATION = 10000;

function groupReplyRows(rows, keys) {
  const groups = new Map();
  for (const row of rows) {
    const key = row.lookup_key || row.thread_key || row.thread_id || (keys.length === 1 ? keys[0] : null);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return groups;
}

async function replyContexts(userId, ids, { accountId, threaded }) {
  const seeds = (await query(`
    SELECT m.id, m.account_id, m.folder, m.message_id, m.in_reply_to,
      m.thread_references, m.thread_id, m.thread_key, m.date, m.uid FROM messages m
    JOIN email_accounts a ON a.id = m.account_id
    WHERE m.id = ANY($1::uuid[]) AND a.user_id = $2 AND a.enabled = true
      AND m.is_deleted = false AND m.folder = 'INBOX'`, [ids, userId])).rows
    .filter(row => ids.includes(row.id) && (!accountId || row.account_id === accountId));
  const keys = [...new Set(seeds.map(row => row.thread_key || row.thread_id).filter(Boolean))];
  const oversized = new Set();
  const memberRows = threaded && keys.length ? (await query(`
    /* row_members */ SELECT member.*, requested.key AS lookup_key
    FROM unnest($2::text[]) AS requested(key)
    CROSS JOIN LATERAL (
      SELECT m.id, m.account_id, m.folder, m.message_id, m.in_reply_to,
        m.thread_references, m.thread_id, m.thread_key, m.date, m.uid FROM messages m
      JOIN email_accounts a ON a.id = m.account_id
      WHERE a.user_id = $1 AND a.enabled = true AND m.is_deleted = false AND m.folder = 'INBOX'
        AND m.thread_key = requested.key
        AND (($3::uuid IS NOT NULL AND m.account_id = $3)
          OR ($3::uuid IS NULL AND COALESCE(a.include_in_unified_inbox, true)))
      LIMIT $4
    ) member`, [userId, keys, accountId || null, MAX_REPLY_CONVERSATION + 1])).rows : seeds;
  const groups = groupReplyRows(memberRows.filter(row => !accountId || row.account_id === accountId), keys);
  for (const [key, rows] of groups) {
    if (rows.length > MAX_REPLY_CONVERSATION) { oversized.add(key); groups.delete(key); }
  }
  const members = [...groups.values()].flat();
  const accountIds = [...new Set(members.map(row => row.account_id))];
  const accounts = new Map(accountIds.length ? (await query(`
    SELECT * FROM email_accounts WHERE id = ANY($1::uuid[]) AND user_id = $2 AND enabled = true`,
  [accountIds, userId])).rows.filter(account => accountIds.includes(account.id)).map(account => [account.id, account]) : []);
  const paths = new Map();
  if (accounts.size) {
    const folders = (await query(`
      SELECT account_id, path, special_use FROM folders WHERE account_id = ANY($1::uuid[])
        AND COALESCE(no_select, false) = false`, [[...accounts.keys()]])).rows;
    for (const [id, account] of accounts) paths.set(id, draftFolderPaths(id, account.folder_mappings, folders));
  }
  return { seeds, members, paths, accounts, keys, groups, oversized };
}

async function replyGraph(context) {
  const accountIds = [...context.accounts.keys()];
  const requested = context.keys.filter(key => !context.oversized.has(key)).map(key => ({ key,
    thread_ids: [...new Set((context.groups.get(key) || []).map(row => row.thread_id).filter(Boolean))] }));
  if (!accountIds.length || !requested.length) return new Map();
  // Apply the cap to each conversation, so a large row cannot crowd out the
  // other rows. LATERAL bounds rows transferred without copying account data.
  const conversation = (await query(`
    SELECT conversation.*, requested.key AS lookup_key
    FROM jsonb_to_recordset($2::jsonb) AS requested(key text, thread_ids text[])
    CROSS JOIN LATERAL (
      SELECT id, account_id, message_id, in_reply_to, thread_references, thread_id, thread_key
      FROM messages WHERE account_id = ANY($1::uuid[]) AND is_deleted = false
        AND (thread_key = requested.key OR thread_id = ANY(requested.thread_ids))
      LIMIT $3
    ) conversation`, [accountIds, JSON.stringify(requested), MAX_REPLY_CONVERSATION + 1])).rows;
  const groups = groupReplyRows(conversation, context.keys);
  for (const [key, rows] of groups) if (rows.length > MAX_REPLY_CONVERSATION) context.oversized.add(key);
  const eligible = row => !context.oversized.has(row.lookup_key || row.thread_key || row.thread_id);
  return createReplyGraph([...conversation, ...context.members, ...context.seeds].filter(eligible));
}

function rowMembers(seed, context, threaded) {
  return threaded ? context.groups?.get(seed.thread_key || seed.thread_id) || [] : [seed];
}

function rowDraft(seed, context, index, threaded) {
  const matches = rowMembers(seed, context, threaded).map(member =>
    index.get(member.account_id)?.get(member.message_id)).filter(Boolean);
  return matches.sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0)
    || String(a.id).localeCompare(String(b.id)))[0] || null;
}

function replyScope(input) {
  const accountId = input.accountId || null;
  if (accountId && !UUID_RE.test(accountId)) throw Object.assign(new Error('Invalid account ID'), { status: 400 });
  return { accountId, threaded: input.threaded === true || input.threaded === 'true' };
}

const CACHED_DRAFT_PAGE_SIZE = 500;

async function cachedReplyDraftIndex(context) {
  const accountIds = [...context.accounts.keys()];
  const paths = [...new Set([...context.paths.values()].flat())];
  if (!accountIds.length || !paths.length) return new Map();
  const pageAfter = async after => (await query(`
    /* draft_candidates */ SELECT id, account_id, folder, uid, message_id,
      in_reply_to, thread_references, thread_id, thread_key, date FROM messages
    WHERE account_id = ANY($1::uuid[]) AND folder = ANY($2::text[]) AND is_deleted = false
      AND (in_reply_to IS NOT NULL OR thread_references IS NOT NULL)
      AND ($3::uuid IS NULL OR id > $3::uuid)
    ORDER BY id LIMIT $4`, [accountIds, paths, after, CACHED_DRAFT_PAGE_SIZE])).rows;
  let page = await pageAfter(null);
  if (!page.length) return new Map();
  const index = createReplyDraftIndex(await replyGraph(context), context.paths);
  while (page.length) {
    index.add(page);
    if (page.length < CACHED_DRAFT_PAGE_SIZE) break;
    page = await pageAfter(page.at(-1).id);
  }
  return index.result(context.members);
}

router.post('/reply-drafts/indicators', async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length > 100 || ids.some(id => typeof id !== 'string' || !UUID_RE.test(id))) {
    return res.status(400).json({ error: 'At most 100 message IDs required' });
  }
  try {
    const scope = replyScope(req.body);
    const context = await replyContexts(req.session.userId, [...new Set(ids)], scope);
    if (!context.seeds.length) return res.json({ indicators: {} });
    const index = await cachedReplyDraftIndex(context);
    res.json({ indicators: Object.fromEntries(context.seeds.map(seed => {
      const draft = rowDraft(seed, context, index, scope.threaded);
      return [seed.id, context.oversized.has(seed.thread_key || seed.thread_id) ? { unknown: true }
        : { exists: Boolean(draft), ...(draft ? { accountId: draft.account_id } : {}) }];
    })) });
  } catch (err) {
    console.error('Reply draft indicators failed:', err.message);
    res.status(err.status || 503).json({ error: 'Could not check reply drafts' });
  }
});

router.get('/messages/:id/reply-draft', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid message ID' });
  try {
    const scope = replyScope(req.query);
    const context = await replyContexts(req.session.userId, [req.params.id], scope);
    const selected = context.seeds[0];
    if (!selected) return res.status(404).json({ error: 'Message not found' });
    const candidates = [];
    const searches = new Map();
    const graph = await replyGraph(context);
    if (context.oversized.has(selected.thread_key || selected.thread_id)) throw new Error('Reply conversation is too large to check');
    const reachable = replyChainIdsFor(graph, rowMembers(selected, context, scope.threaded));
    for (const [accountId, account] of context.accounts) {
      const ids = [...reachable.get(accountId) || []];
      const paths = context.paths.get(accountId) || [];
      if (!ids.length || !paths.length) continue;
      searches.set(accountId, { account, paths, ids });
      candidates.push(...await imapManager.findReplyDrafts(account, paths, ids));
    }
    const index = indexReplyDrafts(graph, candidates, context.paths);
    const draft = rowDraft(selected, context, index, scope.threaded);
    if (!draft || req.query.open !== 'true') return res.json({ draft });
    if (!draft.message_id) throw new Error('This draft has no verifiable Message-ID');
    const search = searches.get(draft.account_id);
    const body = await imapManager.fetchMessageBody(search.account, draft.uid, draft.folder);
    if (body?.html == null && body?.text == null) throw new Error('Could not read the reply draft body');
    const confirmed = await imapManager.confirmReplyDraft(search.account, draft);
    const stillReplies = confirmed && [...headerIds(confirmed.in_reply_to), ...headerIds(confirmed.thread_references)]
      .some(id => search.ids.includes(id));
    if (!confirmed || confirmed.folder !== draft.folder || Number(confirmed.uid) !== Number(draft.uid)
      || confirmed.message_id !== draft.message_id || confirmed.uid_validity !== draft.uid_validity || !stillReplies) return res.status(409).json({ error: 'This reply draft changed on the mail server. Try again.' });
    res.json({ draft: confirmed, body: { ...body,
      html: body.html == null ? null : sanitizeEmail(body.html, { preserveDraftSignature: true }) } });
  } catch (err) {
    console.error('Reply draft lookup failed:', err.message);
    res.status(err.status || 503).json({ error: 'Could not check reply drafts' });
  }
});

function sanitizeHeaderValue(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\r\n\0]/g, '').trim();
}

function replyHeader(value, single = false) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.length > 8192) throw Object.assign(new Error('Invalid reply header'), { status: 400 });
  const unfolded = value.replace(/\r\n[ \t]+/g, ' ').trim();
  const valid = single ? /^<[^<>\s]+>$/ : /^<[^<>\s]+>(?:[ \t]+<[^<>\s]+>)*$/;
  if (/[\r\n\0]/.test(unfolded) || !valid.test(unfolded)) throw Object.assign(new Error('Invalid reply header'), { status: 400 });
  return unfolded;
}

// Extract { name, email } from an RFC 5322 address string ("Name <email>",
// "<email>", or bare "email") for persisting to_addresses/cc_addresses/bcc_addresses.
function parseAddress(str) {
  if (typeof str !== 'string') return { name: '', email: '' };
  const m = str.match(/^(.+?)\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim().replace(/^"|"$/g, '').trim(), email: m[2].trim().toLowerCase() };
  const bare = str.match(/^\s*<([^>]+)>\s*$/);
  if (bare) return { name: '', email: bare[1].trim().toLowerCase() };
  return { name: '', email: str.trim().toLowerCase() };
}
function mapRecipientList(list) {
  return (Array.isArray(list) ? list : []).filter(Boolean).map(addr => parseAddress(addr));
}

function textToHtml(text) {
  return text.split('\n')
    .map(l => `<p style="margin:0">${l.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') || '&nbsp;'}</p>`)
    .join('');
}

async function buildRawDraft({ accountId, aliasId, to, cc, bcc, subject, body, bodyIsHtml, quotedBody, quotedBodyHtml, editedSignature, inReplyTo, references }) {
  const replyToId = replyHeader(inReplyTo, true);
  const referenceIds = replyHeader(references) || replyToId;
  const acctResult = await query(
    'SELECT * FROM email_accounts WHERE id = $1',
    [accountId]
  );
  if (!acctResult.rows.length) throw Object.assign(new Error('Account not found'), { status: 404 });
  const account = acctResult.rows[0];

  let fromName = account.sender_name || account.name;
  let fromEmail = account.email_address;
  let fromSignature = account.signature;

  if (aliasId) {
    const aliasResult = await query(
      'SELECT * FROM account_aliases WHERE id = $1 AND account_id = $2',
      [aliasId, accountId]
    );
    if (aliasResult.rows.length) {
      const alias = aliasResult.rows[0];
      fromName = alias.name;
      fromEmail = alias.email;
      if (alias.signature !== null) fromSignature = alias.signature;
    }
  }

  const rawSignature = editedSignature !== undefined ? (editedSignature || null) : fromSignature;
  const effectiveSignature = rawSignature ? sanitizeSignature(rawSignature) : null;

  const sigText = effectiveSignature
    ? sanitizeHtml(effectiveSignature, { allowedTags: [], allowedAttributes: {} }).trim()
    : null;

  const bodyText = bodyIsHtml
    ? sanitizeHtml(body || '', { allowedTags: [], allowedAttributes: {} })
    : (body || '');

  const bodyHtml = bodyIsHtml
    ? sanitizeComposeBody(body || '')
    : textToHtml(body || '');

  const rawHtml = bodyHtml +
    // data-mailflow-signature marks the block so reopening this draft can lift the signature
    // back out instead of leaving it in the body and appending a second one. Without it every
    // save/reopen cycle added another copy (#432). Other clients ignore the attribute.
    (effectiveSignature ? `<div data-mailflow-signature="1" style="margin-top:16px;color:#555;font-size:13px">${effectiveSignature}</div>` : '') +
    (quotedBodyHtml || (quotedBody ? textToHtml(quotedBody) : ''));
  const { html: draftHtml, attachments: inlineImageAttachments } = embedInlineDataImages(rawHtml);

  // Stable Message-ID so the appended MIME and the local DB row reference the same
  // message (and a later sync reconciles cleanly).
  const messageId = `<${randomBytes(16).toString('hex')}@${(fromEmail.split('@')[1] || 'mailflow.local')}>`;
  const textBody = sigText ? `${bodyText}\n\n-- \n${sigText}${quotedBody || ''}` : `${bodyText}${quotedBody || ''}`;

  const mailOptions = {
    messageId,
    from: `${fromName} <${fromEmail}>`,
    to: (Array.isArray(to) ? to : [to]).filter(Boolean).join(', ') || undefined,
    cc: (Array.isArray(cc) ? cc : []).filter(Boolean).join(', ') || undefined,
    bcc: (Array.isArray(bcc) ? bcc : []).filter(Boolean).join(', ') || undefined,
    subject: sanitizeHeaderValue(subject || ''),
    ...(replyToId ? { inReplyTo: replyToId } : {}),
    ...(referenceIds ? { references: referenceIds } : {}),
    text: textBody,
    html: draftHtml,
    ...(inlineImageAttachments.length ? { attachments: inlineImageAttachments } : {}),
  };

  const streamTransport = nodemailer.createTransport({ streamTransport: true, newline: 'unix' });
  const streamInfo = await streamTransport.sendMail(mailOptions);
  const chunks = [];
  await new Promise((resolve, reject) => {
    streamInfo.message.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    streamInfo.message.on('end', resolve);
    streamInfo.message.on('error', reject);
  });
  // rawHtml (pre inline-image embedding) is what the composer should reopen with —
  // inline data: URIs stay editable and getMessageBody serves body_html from the DB.
  const snippet = textBody.replace(/\s+/g, ' ').trim().slice(0, 200);
  return {
    rawMessage: Buffer.concat(chunks),
    account,
    meta: { messageId, fromName, fromEmail, bodyHtml: rawHtml, bodyText: textBody, snippet, inReplyTo: replyToId, references: referenceIds },
  };
}

async function resolveDraftsFolder(account) {
  const mapped = account.folder_mappings?.drafts;
  if (mapped) return mapped;
  const result = await query(
    "SELECT path FROM folders WHERE account_id = $1 AND special_use = '\\Drafts' LIMIT 1",
    [account.id]
  );
  return result.rows[0]?.path || null;
}

// These routes permanently expunge, so they may only touch a Drafts folder: the canonical set; the
// folder this file appends drafts to (resolveDraftsFolder trusts the raw mapping, and a save must
// always be able to replace its own previous copy); and the server's own \Drafts folder, which the
// message list still opens as Drafts when the mapping points somewhere else.
async function isDraftsPath(account, folder, draftsFolder) {
  if (typeof folder !== 'string' || !folder) return false;
  if (folder === (draftsFolder ?? await resolveDraftsFolder(account))) return true;
  if ((await resolveAllDraftsPaths(account.id, account.folder_mappings)).has(folder)) return true;
  const specialUse = await query(
    "SELECT 1 FROM folders WHERE account_id = $1 AND path = $2 AND special_use = '\\Drafts' LIMIT 1",
    [account.id, folder]
  );
  return specialUse.rows.length > 0;
}

// The previous copy a save replaces, or null (logged) when it cannot be pinned down. It lives in
// the account it was last saved to, which is not the saving account once From has been switched.
// The uid goes to IMAP as a UID set, so it must be a single uid ("1:*" would expunge the folder),
// in a Drafts folder, with a local row whose Message-ID the delete checks the server copy against.
async function findReplacedDraft(userId, account, draftsFolder, { existingUid, existingFolder, existingAccountId }) {
  const refuse = (why) => {
    console.error(`Draft: refusing to delete old uid=${JSON.stringify(existingUid)} in folder ${JSON.stringify(existingFolder)}: ${why}`);
    return null;
  };
  const uid = (typeof existingUid === 'number' || typeof existingUid === 'string')
    && /^[1-9]\d*$/.test(String(existingUid)) ? Number(existingUid) : null;
  if (!uid) return refuse('not a single uid');

  // A composer from before existingAccountId was sent means the saving account.
  let holder = account;
  if (existingAccountId != null && existingAccountId !== account.id) {
    if (typeof existingAccountId !== 'string') return refuse('invalid account');
    const { rows } = await query('SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2', [existingAccountId, userId]);
    if (!rows.length) return refuse(`account ${JSON.stringify(existingAccountId)} not found`);
    holder = rows[0];
  }
  if (!(await isDraftsPath(holder, existingFolder, holder === account ? draftsFolder : undefined))) {
    return refuse('not a Drafts folder');
  }

  const { rows: [row] } = await query(
    'SELECT message_id FROM messages WHERE account_id = $1 AND uid = $2 AND folder = $3',
    [holder.id, uid, existingFolder]
  );
  if (!row?.message_id) return refuse('no local row with a Message-ID to check the server copy against');
  return { account: holder, uid, folder: existingFolder, messageId: row.message_id };
}

// Deletes the draft a message was sent from, once routes/send.js has delivered it. This runs on
// the server, after delivery, because with undo send the delivery happens after the composer has
// closed, possibly with the tab gone too: a draft deleted when Send was clicked would take with it
// the only other copy of a message whose delivery then failed. The checks are those of a save
// replacing its previous copy. Never throws: a draft left behind is logged, not a failed send.
export async function deleteSentDraft(userId, account, { uid, folder, accountId } = {}) {
  try {
    const target = await findReplacedDraft(userId, account, undefined, { existingUid: uid, existingFolder: folder, existingAccountId: accountId });
    if (!target) return false;
    const deleted = await imapManager.permanentDeleteMessage(target.account, target.uid, target.folder, { expectMessageId: target.messageId });
    if (!deleted) {
      console.error(`Draft: not deleting sent draft uid=${target.uid} in folder ${JSON.stringify(target.folder)}: the server copy's Message-ID does not match its local row`);
      return false;
    }
    await query('DELETE FROM messages WHERE account_id = $1 AND uid = $2 AND folder = $3', [target.account.id, target.uid, target.folder]);
    return true;
  } catch (err) {
    console.error(`Draft: failed to delete sent draft uid=${JSON.stringify(uid)}: ${err.message}`);
    return false;
  }
}

router.post('/draft', async (req, res) => {
  const { accountId, aliasId, to, cc, bcc, subject, body, bodyIsHtml = false, quotedBody, quotedBodyHtml, editedSignature, existingUid, existingFolder, existingAccountId, inReplyTo, references } = req.body;
  if (!accountId) return res.status(400).json({ error: 'accountId required' });

  const ownerCheck = await query(
    'SELECT id FROM email_accounts WHERE id = $1 AND user_id = $2',
    [accountId, req.session.userId]
  );
  if (!ownerCheck.rows.length) return res.status(404).json({ error: 'Account not found' });

  try {
    const { rawMessage, account, meta } = await buildRawDraft({ accountId, aliasId, to, cc, bcc, subject, body, bodyIsHtml, quotedBody, quotedBodyHtml, editedSignature, inReplyTo, references });

    const draftsFolder = await resolveDraftsFolder(account);
    if (!draftsFolder) return res.status(422).json({ error: 'No Drafts folder found for this account' });

    // Read the old copy's row before the new draft writes its own: after a UIDVALIDITY reset the
    // new one can land on the same uid, and its row would then vouch for itself.
    let replaced = null;
    if (existingUid && existingFolder) {
      try {
        replaced = await findReplacedDraft(req.session.userId, account, draftsFolder, { existingUid, existingFolder, existingAccountId });
      } catch (err) {
        console.error(`Draft: not deleting old uid=${JSON.stringify(existingUid)}: ${err.message}`);
      }
    }

    // APPEND the new draft first so we never lose the message
    const { uid } = await imapManager.appendToFolder(account, draftsFolder, rawMessage, ['\\Draft', '\\Seen']);

    // Persist a local Drafts row immediately so the composer can reopen this draft
    // (recipient/subject/body) even if the folder re-sync is delayed or fails on a
    // flaky connection. Non-fatal — the append already stored the message on IMAP.
    if (uid != null) {
      try {
        await imapManager.upsertDraftMessageRecord(account, draftsFolder, uid, {
          messageId: meta.messageId,
          subject,
          fromName: meta.fromName,
          fromEmail: meta.fromEmail,
          to: mapRecipientList(to),
          cc: mapRecipientList(cc),
          bcc: mapRecipientList(bcc),
          snippet: meta.snippet,
          bodyHtml: meta.bodyHtml,
          bodyText: meta.bodyText,
          inReplyTo: meta.inReplyTo,
          references: meta.references,
        });
      } catch (rowErr) {
        console.error(`Draft: failed to persist local row uid=${uid}: ${rowErr.message}`);
      }
    }

    // Delete the old draft only after the new one is safely stored.
    if (replaced) {
      try {
        const deleted = await imapManager.permanentDeleteMessage(replaced.account, replaced.uid, replaced.folder, { expectMessageId: replaced.messageId });
        if (!deleted) {
          console.error(`Draft: refusing to delete old uid=${replaced.uid} in folder ${JSON.stringify(replaced.folder)}: the server copy's Message-ID does not match its local row`);
        } else {
          await query(
            'DELETE FROM messages WHERE account_id = $1 AND uid = $2 AND folder = $3',
            [replaced.account.id, replaced.uid, replaced.folder]
          );
        }
      } catch (delErr) {
        console.error(`Draft: failed to delete old uid=${replaced.uid}: ${delErr.message}`);
      }
    }

    res.json({ uid, folder: draftsFolder, ...(req.body.includeIdentity === true ? { messageId: meta.messageId } : {}) });
  } catch (err) {
    console.error('Save draft failed:', err.message);
    res.status(err.status || 500).json({ error: err.message || 'Failed to save draft' });
  }
});

router.delete('/draft/:uid', async (req, res) => {
  const uid = parseInt(req.params.uid, 10);
  if (!uid || !Number.isFinite(uid)) return res.status(400).json({ error: 'Invalid uid' });

  const { accountId, folder } = req.query;
  if (!accountId || !folder) return res.status(400).json({ error: 'accountId and folder required' });

  const ownerCheck = await query(
    'SELECT * FROM email_accounts WHERE id = $1 AND user_id = $2',
    [accountId, req.session.userId]
  );
  if (!ownerCheck.rows.length) return res.status(404).json({ error: 'Account not found' });

  try {
    const account = ownerCheck.rows[0];
    if (!(await isDraftsPath(account, folder))) {
      return res.status(400).json({ error: 'Folder is not a Drafts folder' });
    }
    await imapManager.permanentDeleteMessage(account, uid, folder);
    await query(
      'DELETE FROM messages WHERE account_id = $1 AND uid = $2 AND folder = $3',
      [account.id, uid, folder]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Delete draft failed:', err.message);
    res.status(500).json({ error: err.message || 'Failed to delete draft' });
  }
});

export default router;
