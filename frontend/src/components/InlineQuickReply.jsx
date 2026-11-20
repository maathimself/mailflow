import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';
import { bodyCache } from '../utils/bodyCache.js';
import { unproxyImages } from '../utils/imageProxy.js';
import { resolveSignatureEnabled } from '../utils/composeSignature.js';
import { autoListsOf, openAutoRecipients } from '../utils/autoRecipients.js';
import { modCompactLabel } from '../utils/defaultShortcuts.js';
import { openSentMessage } from '../utils/openSentMessage.js';
import {
  UNDO_SEND_SECONDS,
  undoWindowMs,
  trackHeldSend,
  reopenCompose,
  sendErrorText,
} from '../utils/heldSend.js';
import {
  buildQuotedReply,
  buildReplyDraftData,
  buildReplyMetadata,
  formatAddressStrings,
  isComposeSendShortcut,
  plainToComposeBody,
} from '../utils/composeFromMessage.js';

function shortAddressLabel(list = []) {
  return list
    .map(item => (typeof item === 'string' ? item : item?.name || item?.email || ''))
    .filter(Boolean)
    .join(', ');
}

function scheduleUnrefTimer(fn, ms, trackerRef) {
  const handle = setTimeout(() => {
    trackerRef.current?.delete(handle);
    fn();
  }, ms);
  handle?.unref?.();
  trackerRef.current?.add(handle);
  return handle;
}

export default function InlineQuickReply({
  targetMessage,
  mode = null,
  focusToken = 0,
  isMobile = false,
  conversationKey: conversationKeyProp = '',
}) {
  const { t } = useTranslation();
  const accounts = useStore(s => s.accounts);
  const folders = useStore(s => s.folders);
  const replyDefault = useStore(s => s.replyDefault);
  const plaintextEmail = useStore(s => s.plaintextEmail);
  const openCompose = useStore(s => s.openCompose);
  const addNotification = useStore(s => s.addNotification);
  const setThreadMessages = useStore(s => s.setThreadMessages);

  const [replyAll, setReplyAll] = useState(() => (mode != null ? Boolean(mode) : replyDefault === 'replyAll'));
  const [draftText, setDraftText] = useState('');
  const [sending, setSending] = useState(false);
  const [poppingOut, setPoppingOut] = useState(false);
  const [error, setError] = useState('');

  const sendingRef = useRef(false);
  const textareaRef = useRef(null);
  const idempotencyKeyRef = useRef(null);
  const refreshTimersRef = useRef(new Set());
  const mountedRef = useRef(true);
  const conversationKey = conversationKeyProp
    || `${targetMessage?.account_id || ''}\n${targetMessage?.thread_id || targetMessage?.id || ''}`;
  const activeKeyRef = useRef(conversationKey);
  activeKeyRef.current = conversationKey;

  useEffect(() => {
    idempotencyKeyRef.current = null;
  }, [targetMessage?.id]);

  useEffect(() => {
    mountedRef.current = true;
    const timers = refreshTimersRef.current;
    return () => {
      mountedRef.current = false;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  useEffect(() => {
    if (!focusToken) return;
    if (mode != null) setReplyAll(Boolean(mode));
    setError('');
    textareaRef.current?.focus();
  }, [focusToken, mode]);

  if (!targetMessage) return null;

  const meta = buildReplyMetadata(targetMessage, { accounts, folders, replyAll });
  const finalTo = formatAddressStrings(meta.to);
  const rawCc = formatAddressStrings(meta.cc);
  const auto = openAutoRecipients({ to: finalTo, cc: rawCc, bcc: [] }, autoListsOf(meta.myAccount));
  const finalCc = auto.cc;
  const finalBcc = auto.bcc;

  const toSummary = shortAddressLabel(meta.to) || finalTo.join(', ');
  const ccSummary = replyAll && meta.cc.length === finalCc.length
    ? shortAddressLabel(meta.cc)
    : finalCc.join(', ');

  const myAccount = meta.myAccount;
  const replyAlias = meta.aliasId ? myAccount?.aliases?.find(al => al.id === meta.aliasId) : null;
  const accountSig = replyAlias
    ? (replyAlias.signature !== null && replyAlias.signature !== undefined ? replyAlias.signature : myAccount?.signature)
    : myAccount?.signature;
  const signatureEnabled = resolveSignatureEnabled(myAccount);
  const hasSignature = signatureEnabled && Boolean(String(accountSig || '').replace(/<[^>]*>/g, '').trim());
  const fromEmail = replyAlias?.email || myAccount?.email_address || '';

  const loadMessageBody = id => Promise.resolve(bodyCache.get(id) || api.getMessageBody(id));
  const canSend = !sending && Boolean(draftText.trim()) && finalTo.length > 0 && Boolean(meta.accountId);
  const ccBccTitle = [...finalCc, ...finalBcc].join(', ');

  const resizeTextarea = (el) => {
    if (!el || !el.style) return;
    el.style.height = 'auto';
    if (el.scrollHeight > 0) {
      el.style.height = `${Math.min(Math.max(el.scrollHeight, 52), 180)}px`;
    }
  };

  const triggerThreadRefresh = (threadId, accountId, ownerId) => {
    if (typeof window !== 'undefined' && typeof CustomEvent === 'function') {
      window.dispatchEvent(new CustomEvent('mailflow:thread_refresh', { detail: { accountId } }));
    }
    if (!threadId) return;
    const refreshThread = async () => {
      if (useStore.getState().user?.id !== ownerId) return;
      try {
        const data = await api.getThread(threadId);
        if (useStore.getState().user?.id !== ownerId) return;
        if (data?.messages?.length) setThreadMessages(threadId, data.messages);
        if (typeof window !== 'undefined' && typeof CustomEvent === 'function') {
          window.dispatchEvent(new CustomEvent('mailflow:thread_refresh', { detail: { accountId } }));
        }
      } catch {
        /* best-effort refresh */
      }
    };
    scheduleUnrefTimer(refreshThread, 3000, refreshTimersRef);
    scheduleUnrefTimer(refreshThread, 10000, refreshTimersRef);
  };

  const handlePopOut = async () => {
    if (sendingRef.current || poppingOut) return;
    const capturedKey = activeKeyRef.current;
    const capturedDraft = draftText;
    const capturedReplyAll = replyAll;
    setPoppingOut(true);
    setError('');
    try {
      const draft = await buildReplyDraftData(targetMessage, {
        accounts: useStore.getState().accounts,
        folders: useStore.getState().folders,
        getMessageBody: loadMessageBody,
        replyAll: capturedReplyAll,
        body: plainToComposeBody(capturedDraft, plaintextEmail),
      });
      openCompose(draft);
      if (mountedRef.current && activeKeyRef.current === capturedKey) {
        setDraftText('');
        setError('');
      }
    } finally {
      if (mountedRef.current) setPoppingOut(false);
    }
  };

  const handleSend = async () => {
    if (!canSend || sendingRef.current) return;
    const ownerId = useStore.getState().user?.id;
    const capturedKey = activeKeyRef.current;
    const capturedTarget = targetMessage;
    const capturedText = draftText;
    const capturedReplyAll = replyAll;
    const capturedMeta = meta;
    const capturedTo = finalTo;
    const capturedCc = finalCc;
    const capturedBcc = finalBcc;
    const capturedAuto = auto.auto;
    const capturedSignatureEnabled = signatureEnabled;

    sendingRef.current = true;
    setSending(true);
    setError('');

    if (!idempotencyKeyRef.current) {
      idempotencyKeyRef.current = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }

    try {
      const replyBody = await loadMessageBody(capturedTarget.id).catch(() => null);
      const { quotedBody, quotedBodyHtml } = buildQuotedReply(capturedTarget, replyBody);
      const unproxiedQuotedHtml = !plaintextEmail && quotedBodyHtml != null ? unproxyImages(quotedBodyHtml) : null;

      const payload = {
        accountId: capturedMeta.accountId,
        ...(capturedMeta.aliasId ? { aliasId: capturedMeta.aliasId } : {}),
        to: capturedTo,
        cc: capturedCc,
        bcc: capturedBcc,
        subject: capturedMeta.subject,
        body: capturedText,
        bodyIsHtml: false,
        ...(quotedBody ? { quotedBody } : {}),
        ...(unproxiedQuotedHtml != null ? { quotedBodyHtml: unproxiedQuotedHtml } : {}),
        ...(!capturedSignatureEnabled ? { editedSignature: '' } : {}),
        inReplyTo: capturedMeta.inReplyTo,
        references: capturedMeta.references || undefined,
      };

      const sendResult = await api.post(
        '/mail/send',
        { ...payload, undoSeconds: UNDO_SEND_SECONDS },
        { 'X-Idempotency-Key': idempotencyKeyRef.current },
      );

      idempotencyKeyRef.current = null;
      sendingRef.current = false;
      if (mountedRef.current) {
        setSending(false);
        if (activeKeyRef.current === capturedKey) {
          setDraftText('');
          setError('');
          if (textareaRef.current?.style) textareaRef.current.style.height = 'auto';
        }
      }

      if (useStore.getState().user?.id !== ownerId) return;

      const shownSubject = capturedMeta.subject || t('common.noSubject');
      const reportSent = (result) => {
        const sentFolder = result?.sentFolder
          || useStore.getState().accounts.find(a => a.id === capturedMeta.accountId)?.folder_mappings?.sent
          || 'Sent';
        const sentCopyFailed = result?.sentCopySaved === false;
        addNotification({
          title: sentCopyFailed ? t('compose.sent.noCopy') : t('compose.sent.title'),
          body: shownSubject,
          ...(sentCopyFailed ? {} : {
            onAction: () => openSentMessage(useStore, {
              accountId: capturedMeta.accountId,
              folder: sentFolder,
              messageId: result?.messageId,
            }),
            actionLabel: t('compose.sent.action'),
          }),
        });
        if (result?.rejected?.length) {
          addNotification({
            type: 'error',
            title: shownSubject,
            body: t('compose.sent.someRejected', { addresses: result.rejected.join(', ') }),
            allowWrap: true,
            persistent: true,
          });
        }
        triggerThreadRefresh(capturedMeta.threadId, capturedMeta.accountId, ownerId);
      };

      if (sendResult?.pending) {
        const restoreData = {
          to: capturedTo,
          cc: capturedCc,
          bcc: capturedBcc,
          autoRecipients: { ...capturedAuto, accountId: capturedMeta.accountId },
          subject: capturedMeta.subject,
          body: plainToComposeBody(capturedText, plaintextEmail),
          quotedBody,
          quotedBodyHtml: unproxiedQuotedHtml,
          ...(capturedSignatureEnabled ? {} : { signature: '' }),
          inReplyTo: capturedMeta.inReplyTo,
          references: capturedMeta.references,
          accountId: capturedMeta.accountId,
          aliasId: capturedMeta.aliasId,
          isReply: true,
          isReplyAll: capturedReplyAll,
          originalFrom: capturedMeta.originalFrom,
          allRecipients: capturedMeta.allRecipients,
          threadId: capturedMeta.threadId,
          restored: true,
        };
        const pendingId = sendResult.pendingId;
        const undoMs = undoWindowMs(sendResult.remainingMs);
        const { addNotification: notify, removeNotification } = useStore.getState();
        const undo = trackHeldSend(
          { pendingId, undoMs, subject: shownSubject },
          {
            restore: (sendError) => reopenCompose(useStore, { ...restoreData, ...(sendError ? { sendError } : {}) }),
            onSent: reportSent,
          },
          {
            getStatus: api.getSendStatus,
            cancel: api.cancelSend,
            notify,
            dismissUndo: () => {
              for (const n of useStore.getState().notifications) {
                if (n.heldSendId === pendingId) removeNotification(n.id);
              }
            },
            onOwnerChange: (stop) => useStore.subscribe(state => { if (state.user?.id !== ownerId) stop(); }),
            t,
          },
        );
        notify({
          title: t('compose.undoSend.sending', { subject: shownSubject }),
          heldSendId: pendingId,
          undoMs,
          onUndo: undo,
        });
        return;
      }

      reportSent(sendResult);
    } catch (err) {
      sendingRef.current = false;
      if (mountedRef.current) {
        setSending(false);
        setError(sendErrorText(err, t) || err?.message || 'Request failed');
      }
    }
  };

  const handleKeyDown = (e) => {
    if (isComposeSendShortcut(e)) {
      e.preventDefault();
      e.stopPropagation();
      void handleSend();
    } else if (e.key === 'Escape') {
      if (error) {
        e.stopPropagation();
        setError('');
      } else {
        e.currentTarget.blur();
      }
    }
  };

  const modeBtnStyle = (active) => ({
    border: '1px solid ' + (active ? 'var(--accent)' : 'var(--border)'),
    background: active ? 'color-mix(in srgb, var(--accent) 14%, transparent)' : 'transparent',
    color: active ? 'var(--accent)' : 'var(--text-secondary)',
    borderRadius: 5,
    padding: isMobile ? '4px 8px' : '2px 8px',
    fontSize: 11,
    fontWeight: active ? 600 : 500,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  });

  const hasAllRecipients = meta.allRecipients.length > 0;

  return (
    <div
      role="region"
      aria-label={t('quickReply.regionLabel')}
      data-inline-quick-reply=""
      style={{
        flexShrink: 0,
        borderTop: '1px solid var(--border-subtle)',
        background: 'var(--bg-secondary)',
        padding: isMobile ? '8px 10px' : '10px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
          <button
            type="button"
            aria-pressed={!replyAll}
            onClick={() => {
              idempotencyKeyRef.current = null;
              setReplyAll(false);
            }}
            style={modeBtnStyle(!replyAll)}
          >
            {t('message.reply')}
          </button>
          {(hasAllRecipients || replyAll) && (
            <button
              type="button"
              aria-pressed={replyAll}
              onClick={() => {
                idempotencyKeyRef.current = null;
                setReplyAll(true);
              }}
              style={modeBtnStyle(replyAll)}
            >
              {t('message.replyAll')}
            </button>
          )}
        </div>

        <div
          title={finalTo.join(', ')}
          style={{
            flex: '1 1 140px',
            minWidth: 0,
            fontSize: 12,
            color: 'var(--text-secondary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          <span style={{ color: 'var(--text-tertiary)', marginRight: 4 }}>{`${t('compose.to')}:`}</span>
          <span>{toSummary}</span>
          {(finalCc.length > 0 || finalBcc.length > 0) && (
            <span title={ccBccTitle} style={{ color: 'var(--text-tertiary)', marginLeft: 8 }}>
              {finalCc.length > 0 ? `${t('compose.cc')}: ${ccSummary}` : ''}
              {finalBcc.length > 0 ? `${finalCc.length > 0 ? ' · ' : ''}${t('compose.bcc')}: ${finalBcc.join(', ')}` : ''}
            </span>
          )}
        </div>

        {accounts.length > 1 && fromEmail && (
          <div
            title={`${t('compose.from')}: ${fromEmail}`}
            style={{
              fontSize: 11,
              color: 'var(--text-tertiary)',
              maxWidth: 160,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {fromEmail}
          </div>
        )}

        <button
          type="button"
          onClick={handlePopOut}
          disabled={sending || poppingOut}
          title={t('quickReply.popOut')}
          aria-label={t('quickReply.popOut')}
          style={{
            background: 'transparent',
            border: '1px solid var(--border)',
            borderRadius: 5,
            padding: isMobile ? '6px 8px' : '3px 6px',
            color: 'var(--text-secondary)',
            cursor: sending || poppingOut ? 'default' : 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <polyline points="15 3 21 3 21 9" />
            <polyline points="9 21 3 21 3 15" />
            <line x1="21" y1="3" x2="14" y2="10" />
            <line x1="3" y1="21" x2="10" y2="14" />
          </svg>
        </button>
      </div>

      {error && (
        <div role="alert" style={{
          fontSize: 12,
          color: 'var(--red, #e03131)',
          background: 'color-mix(in srgb, var(--red, #e03131) 10%, transparent)',
          border: '1px solid color-mix(in srgb, var(--red, #e03131) 30%, transparent)',
          borderRadius: 5,
          padding: '5px 8px',
        }}>
          {error}
        </div>
      )}

      <textarea
        ref={textareaRef}
        rows={2}
        value={draftText}
        disabled={sending}
        placeholder={t('quickReply.placeholder')}
        aria-label={t('quickReply.placeholder')}
        onChange={(e) => {
          idempotencyKeyRef.current = null;
          setDraftText(e.target.value);
          resizeTextarea(e.target);
        }}
        onKeyDown={handleKeyDown}
        style={{
          width: '100%',
          boxSizing: 'border-box',
          minHeight: 52,
          maxHeight: 180,
          resize: 'none',
          overflowY: 'auto',
          background: 'var(--bg-primary)',
          color: 'var(--text-primary)',
          border: '1px solid var(--border)',
          borderRadius: 6,
          padding: '8px 10px',
          font: 'inherit',
          fontSize: 13,
          lineHeight: 1.45,
          outline: 'none',
        }}
      />

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ fontSize: 11, color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {hasSignature ? t('quickReply.signatureIncluded') : ''}
        </div>
        <button
          type="button"
          onClick={handleSend}
          disabled={!canSend}
          title={`${t('compose.send')} (${modCompactLabel('ctrl')}↵)`}
          style={{
            background: canSend ? 'var(--accent)' : 'var(--bg-tertiary)',
            color: canSend ? 'var(--accent-text, #fff)' : 'var(--text-tertiary)',
            border: '1px solid ' + (canSend ? 'var(--accent)' : 'var(--border)'),
            borderRadius: 6,
            padding: isMobile ? '6px 14px' : '4px 12px',
            fontSize: 12,
            fontWeight: 600,
            cursor: canSend ? 'pointer' : 'default',
            flexShrink: 0,
          }}
        >
          {sending ? t('compose.sending') : t('compose.send')}
        </button>
      </div>
    </div>
  );
}
