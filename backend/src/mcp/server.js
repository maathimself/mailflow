import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { sendEmail } from '../services/emailSend.js';
import {
  listAccounts, listFolders, listMessages, getUnreadCounts,
  getMessage, getThread, searchMessages,
} from '../services/messageQueries.js';
import {
  setMessageRead, setMessageStarred, moveSingleMessage,
  deleteSingleMessage, archiveSingleMessage,
} from '../services/mailActions.js';

function text(content) {
  return { content: [{ type: 'text', text: typeof content === 'string' ? content : JSON.stringify(content, null, 2) }] };
}

function parseAddresses(field) {
  if (!field) return [];
  if (Array.isArray(field)) return field.map(a => a.email).filter(Boolean);
  try { return JSON.parse(field).map(a => a.email).filter(Boolean); } catch { return []; }
}

export function createMcpServer(userId, imapManager) {
  const server = new McpServer({ name: 'mailflow', version: '1.0.0' });

  // ── list_accounts ──────────────────────────────────────────────────────────
  server.tool('list_accounts', 'List all configured email accounts', {}, async () => {
    return text(await listAccounts(userId));
  });

  // ── list_folders ───────────────────────────────────────────────────────────
  server.tool('list_folders', 'List folders for an account', {
    account_id: z.string().optional().describe('Account ID — omit for all accounts'),
  }, async ({ account_id }) => {
    return text(await listFolders(userId, account_id));
  });

  // ── list_messages ──────────────────────────────────────────────────────────
  server.tool('list_messages', 'List messages from the inbox or a specific folder', {
    account_id:  z.string().optional().describe('Filter by account ID'),
    folder:      z.string().optional().describe('Folder path, e.g. "INBOX"'),
    unread_only: z.boolean().optional().describe('Only return unread messages'),
    limit:       z.number().int().min(1).max(100).default(20),
    offset:      z.number().int().min(0).default(0),
  }, async ({ account_id, folder, unread_only, limit, offset }) => {
    return text(await listMessages(userId, { accountId: account_id, folder, unreadOnly: unread_only, limit, offset }));
  });

  // ── get_message ────────────────────────────────────────────────────────────
  server.tool('get_message', 'Get the full content of a message', {
    id: z.string().describe('Message ID'),
  }, async ({ id }) => {
    const msg = await getMessage(id, userId);
    return msg ? text(msg) : text('Message not found');
  });

  // ── get_thread ─────────────────────────────────────────────────────────────
  server.tool('get_thread', 'Get all messages in a conversation thread', {
    thread_id: z.string().describe('Thread ID'),
  }, async ({ thread_id }) => {
    return text(await getThread(thread_id, userId));
  });

  // ── search_messages ────────────────────────────────────────────────────────
  server.tool('search_messages', 'Full-text search across all messages', {
    q:          z.string().describe('Search query'),
    account_id: z.string().optional(),
    limit:      z.number().int().min(1).max(50).default(20),
  }, async ({ q, account_id, limit }) => {
    return text(await searchMessages(userId, q, { accountId: account_id, limit }));
  });

  // ── mark_read ──────────────────────────────────────────────────────────────
  server.tool('mark_read', 'Mark a message as read or unread', {
    id:   z.string(),
    read: z.boolean().default(true),
  }, async ({ id, read }) => {
    try {
      return text(await setMessageRead(id, userId, read, imapManager));
    } catch (err) {
      return text(err.message);
    }
  });

  // ── mark_starred ───────────────────────────────────────────────────────────
  server.tool('mark_starred', 'Star or unstar a message', {
    id:      z.string(),
    starred: z.boolean().default(true),
  }, async ({ id, starred }) => {
    try {
      return text(await setMessageStarred(id, userId, starred, imapManager));
    } catch (err) {
      return text(err.message);
    }
  });

  // ── move_message ───────────────────────────────────────────────────────────
  server.tool('move_message', 'Move a message to a different folder', {
    id:        z.string(),
    to_folder: z.string().describe('Destination folder path'),
  }, async ({ id, to_folder }) => {
    try {
      await moveSingleMessage(id, userId, to_folder, imapManager);
      return text({ ok: true, id, to_folder });
    } catch (err) {
      return text(`Move failed: ${err.message}`);
    }
  });

  // ── send_email ─────────────────────────────────────────────────────────────
  server.tool('send_email', 'Compose and send a new email', {
    account_id: z.string().describe('Account ID to send from'),
    to:         z.string().describe('Recipient address(es), comma-separated'),
    subject:    z.string(),
    body:       z.string().describe('Plain text body'),
    cc:         z.string().optional(),
  }, async ({ account_id, to, subject, body, cc }) => {
    try {
      await sendEmail({
        accountId: account_id,
        to: to.split(',').map(s => s.trim()),
        cc: cc ? cc.split(',').map(s => s.trim()) : [],
        subject,
        body,
      }, userId, imapManager);
      return text({ ok: true });
    } catch (err) {
      return text(`Send failed: ${err.message}`);
    }
  });

  // ── reply_to_message ───────────────────────────────────────────────────────
  server.tool('reply_to_message', 'Reply to an existing message', {
    id:        z.string().describe('Message ID to reply to'),
    body:      z.string().describe('Plain text reply body'),
    reply_all: z.boolean().default(false),
  }, async ({ id, body, reply_all }) => {
    const msg = await getMessage(id, userId);
    if (!msg) return text('Message not found');

    let cc = [];
    if (reply_all) {
      const toAddrs = parseAddresses(msg.to_addresses).filter(e => e !== msg.account_email);
      cc = [...toAddrs, ...parseAddresses(msg.cc_addresses)];
    }

    const dateStr = new Date(msg.date).toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short' });
    const sender = msg.from_name || msg.from_email;
    const quotedBody = msg.body_text
      ? `\n\nOn ${dateStr}, ${sender} wrote:\n\n${msg.body_text.split('\n').map(l => `> ${l}`).join('\n')}`
      : undefined;
    const quotedBodyHtml = msg.body_html
      ? `<div style="margin-top:16px;border-top:1px solid #ccc;padding-top:8px;color:#555;font-size:13px"><b>On ${dateStr}, ${sender} wrote:</b></div><blockquote style="margin:8px 0 0 8px;padding-left:12px;border-left:3px solid #ccc">${msg.body_html}</blockquote>`
      : undefined;

    try {
      await sendEmail({
        accountId: msg.account_id,
        to: [msg.reply_to || msg.from_email],
        cc,
        subject: msg.subject?.startsWith('Re:') ? msg.subject : `Re: ${msg.subject || ''}`,
        body,
        inReplyTo: msg.message_id,
        references: msg.message_id,
        quotedBody,
        quotedBodyHtml,
      }, userId, imapManager);
      return text({ ok: true });
    } catch (err) {
      return text(`Reply failed: ${err.message}`);
    }
  });

  // ── sync ───────────────────────────────────────────────────────────────────
  server.tool('sync', 'Trigger an IMAP sync to pull in the latest emails', {
    account_id: z.string().optional().describe('Sync a specific account — omit for all accounts'),
  }, async ({ account_id }) => {
    imapManager.syncNow(userId, account_id || null)
      .catch(err => console.error('MCP syncNow error:', err.message));
    return text({ ok: true, message: 'Sync started in background' });
  });

  // ── get_unread_counts ──────────────────────────────────────────────────────
  server.tool('get_unread_counts', 'Get unread message counts per folder across all accounts', {
    account_id: z.string().optional(),
  }, async ({ account_id }) => {
    const rows = await getUnreadCounts(userId, account_id);
    return text({ total_unread: rows.reduce((sum, r) => sum + r.unread_count, 0), by_folder: rows });
  });

  // ── delete_message ─────────────────────────────────────────────────────────
  server.tool('delete_message', 'Move a message to trash', {
    id: z.string(),
  }, async ({ id }) => {
    try {
      await deleteSingleMessage(id, userId, imapManager);
      return text({ ok: true });
    } catch (err) {
      return text(`Delete failed: ${err.message}`);
    }
  });

  // ── archive_message ────────────────────────────────────────────────────────
  server.tool('archive_message', 'Move a message to the archive folder', {
    id: z.string(),
  }, async ({ id }) => {
    try {
      const result = await archiveSingleMessage(id, userId, imapManager);
      return text({ ok: true, archived_to: result.archiveFolder });
    } catch (err) {
      return text(`Archive failed: ${err.message}`);
    }
  });

  // ── forward_email ──────────────────────────────────────────────────────────
  server.tool('forward_email', 'Forward a message to another recipient', {
    id:   z.string().describe('Message ID to forward'),
    to:   z.string().describe('Recipient address(es), comma-separated'),
    note: z.string().optional().describe('Optional note to add above the forwarded message'),
  }, async ({ id, to, note }) => {
    const msg = await getMessage(id, userId);
    if (!msg) return text('Message not found');

    const dateStr = new Date(msg.date).toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short' });
    const fromStr = msg.from_name ? `${msg.from_name} <${msg.from_email}>` : msg.from_email;
    const fwdHeader = `---------- Forwarded message ----------\nFrom: ${fromStr}\nDate: ${dateStr}\nSubject: ${msg.subject || ''}\n\n`;
    const fwdHeaderHtml = `<div style="margin-top:16px;border-top:1px solid #ccc;padding-top:10px;color:#555;font-size:13px"><b>---------- Forwarded message ----------</b><br><b>From:</b> ${fromStr}<br><b>Date:</b> ${dateStr}<br><b>Subject:</b> ${msg.subject || ''}</div>`;

    try {
      await sendEmail({
        accountId: msg.account_id,
        to: to.split(',').map(s => s.trim()),
        subject: `Fwd: ${msg.subject || ''}`,
        body: note || '',
        quotedBody: fwdHeader + (msg.body_text || ''),
        quotedBodyHtml: fwdHeaderHtml + (msg.body_html || msg.body_text || ''),
      }, userId, imapManager);
      return text({ ok: true });
    } catch (err) {
      return text(`Forward failed: ${err.message}`);
    }
  });

  return server;
}
