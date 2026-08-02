const FORM_FIELDS = Object.freeze([
  'accountId', 'aliasId', 'mode', 'to', 'cc', 'bcc', 'subject', 'body',
  'bodyIsHtml', 'quotedBody', 'quotedBodyHtml', 'editedSignature',
  'forwardedAttachments', 'priority', 'inReplyTo', 'references', 'fromChanged',
]);

function copy(value) {
  if (value === undefined) return undefined;
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

export function initialComposeForm(session = {}, options = {}) {
  const bodyIsHtml = typeof session.bodyIsHtml === 'boolean'
    ? session.bodyIsHtml
    : options.defaultPlaintext !== true;
  const editedSignature = session.editedSignature != null
    ? String(session.editedSignature)
    : String(options.accountSignature || '');
  return {
    accountId: session.accountId || '',
    aliasId: session.aliasId ?? null,
    mode: session.mode || 'new',
    to: copy(session.to || []),
    cc: copy(session.cc || []),
    bcc: copy(session.bcc || []),
    subject: session.subject || '',
    body: session.body || '',
    bodyIsHtml,
    quotedBody: session.quotedBody || '',
    quotedBodyHtml: session.quotedBodyHtml ?? null,
    editedSignature,
    forwardedAttachments: copy(session.forwardedAttachments || []),
    priority: session.priority || 'normal',
    inReplyTo: session.inReplyTo ?? null,
    references: copy(session.references || []),
    fromChanged: Boolean(session.fromChanged),
  };
}

export function composeFormPatch(form, authoritative = {}) {
  const patch = {};
  for (const field of FORM_FIELDS) patch[field] = copy(form[field]);
  patch.accountId = form.accountId || authoritative.accountId || '';
  patch.aliasId = form.aliasId ?? authoritative.aliasId ?? null;
  patch.bodyIsHtml = form.bodyIsHtml === true;
  patch.quotedBodyHtml = form.quotedBodyHtml ?? null;
  patch.editedSignature = form.editedSignature || '';
  patch.fromChanged = Boolean(form.fromChanged)
    || patch.accountId !== (authoritative.accountId || '')
    || patch.aliasId !== (authoritative.aliasId ?? null);
  return patch;
}

export function reconcileComposeForm(current, authoritative, dirtyFields = new Set()) {
  const next = { ...current };
  for (const field of FORM_FIELDS) {
    if (dirtyFields.has(field) || !Object.hasOwn(authoritative, field)) continue;
    next[field] = copy(authoritative[field]);
  }
  return next;
}

export async function uploadFilesSequentially(files, upload) {
  const results = [];
  for (const file of files) results.push(await upload(file));
  return results;
}

export function composeChipPresentation(session = {}) {
  if (session.terminalPending) {
    return { code: 'terminalPending', defaultLabel: 'Finishing draft', warning: false, indicator: '…' };
  }
  if (session.conflict || session.recoveryConflict || session.status === 'conflict') {
    return { code: 'conflict', defaultLabel: 'Conflict', warning: true, indicator: '!' };
  }
  if (session.status === 'offline') {
    return { code: 'offline', defaultLabel: 'Offline', warning: true, indicator: '!' };
  }
  if (session.status === 'error' || session.error) {
    return { code: 'error', defaultLabel: 'Error', warning: true, indicator: '!' };
  }
  if (session.status === 'saving') {
    return { code: 'saving', defaultLabel: 'Saving', warning: false, indicator: '…' };
  }
  if (session.status === 'dirty' || Object.keys(session.localChanges || {}).length > 0) {
    return { code: 'dirty', defaultLabel: 'Dirty', warning: false, indicator: '•' };
  }
  return { code: 'saved', defaultLabel: 'Saved', warning: false, indicator: null };
}

export function composeChipInteraction(session = {}) {
  const disabled = Boolean(session.terminalPending);
  return {
    disabled,
    tabIndex: disabled ? -1 : 0,
    ariaBusy: disabled,
    action: disabled
      ? null
      : (session.presentationState === 'minimized' ? 'restore' : 'focus'),
  };
}

const SESSION_PERSISTENCE_KEYS = Object.freeze({
  terminalPending: 'compose.sessions.terminalPending',
  conflict: 'compose.sessions.conflict',
  minimized: 'compose.sessions.minimized',
  saving: 'compose.sessions.saving',
  offline: 'compose.sessions.offline',
  error: 'compose.sessions.error',
  saved: 'compose.sessions.saved',
});

export function composeSessionPersistenceCode(session = {}) {
  if (session.terminalPending) return 'terminalPending';
  if (session.recoveryConflict || session.conflict) return 'conflict';
  if (session.presentationState === 'minimized') return 'minimized';
  if (session.status === 'saving') return 'saving';
  if (session.status === 'offline') return 'offline';
  if (session.status === 'error' || session.error) return 'error';
  if (session.status === 'clean' || session.status === 'idle') return 'saved';
  return null;
}

export function composeSessionCanFocus(session) {
  return Boolean(session) && !session.terminalPending;
}

export function composeSessionSlotLabel(session, t) {
  return t('compose.sessions.slotLabel', { slot: session.slot });
}

export function composeSessionRegionLabel(session, t) {
  const subject = session.subject?.trim() || t('common.noSubject');
  return `${composeSessionSlotLabel(session, t)}: ${subject}`;
}

export function composeSessionAnnouncement(session, t) {
  if (!session) return '';
  const slot = composeSessionSlotLabel(session, t);
  const code = composeSessionPersistenceCode(session);
  return code ? `${slot}: ${t(SESSION_PERSISTENCE_KEYS[code])}` : slot;
}

export function localDockBounds(rect, containingBlockRect = {}, uiScale = 1) {
  const scale = Number.isFinite(uiScale) && uiScale > 0 ? uiScale : 1;
  const originTop = Number(containingBlockRect.top) || 0;
  const originLeft = Number(containingBlockRect.left) || 0;
  return {
    top: (Number(rect.top) - originTop) / scale,
    left: (Number(rect.left) - originLeft) / scale,
    width: Number(rect.width) / scale,
    height: Number(rect.height) / scale,
  };
}

export function attachmentChipView(attachment = {}) {
  return {
    ...attachment,
    name: attachment.name || attachment.filename,
    size: attachment.size ?? attachment.byteCount,
    type: attachment.type || attachment.mediaType || attachment.contentType,
  };
}

export function replyAllRecipientsForSession(session = {}) {
  return copy(session.replyAllRecipients ?? session.allRecipients ?? []);
}

export async function runAfterStableAttachmentMutations(getPending, action) {
  let firstError = null;
  while (true) {
    const pending = getPending();
    try {
      await pending;
    } catch (error) {
      firstError ||= error;
    }
    if (getPending() !== pending) continue;
    if (firstError) throw firstError;
    return action();
  }
}

export async function persistComposeDraft({
  sessionId,
  changes,
  getChanges,
  closeAfter = false,
  waitForAttachments = action => action(),
  onChange = () => {},
  onSave = () => {},
  onClose = () => {},
  onSavingChange = () => {},
  onError = () => {},
}) {
  onSavingChange(true);
  try {
    return await waitForAttachments(() => {
      const currentChanges = getChanges ? getChanges() : changes;
      if (closeAfter) {
        onChange(sessionId, currentChanges);
        return onClose(sessionId);
      }
      return onSave(sessionId, currentChanges);
    });
  } catch (error) {
    onError(error);
    return null;
  } finally {
    onSavingChange(false);
  }
}

export function composeHydrationStep(state, event, options = {}) {
  const current = state || {
    ready: false,
    form: null,
    baseline: null,
    emitted: null,
  };
  if (event?.type === 'summary') return { ...current, emitted: null };
  if (event?.type === 'snapshot') {
    const form = current.ready
      ? reconcileComposeForm(current.form, event.session, event.dirtyFields || new Set())
      : initialComposeForm(event.session, options);
    return {
      ready: true,
      form,
      baseline: composeFormPatch(form, event.session),
      emitted: null,
    };
  }
  if (event?.type === 'user-change' && current.ready) {
    const form = { ...current.form, ...copy(event.changes || {}) };
    const emitted = composeFormPatch(form, event.session || {});
    return { ...current, form, baseline: emitted, emitted };
  }
  return { ...current, emitted: null };
}
