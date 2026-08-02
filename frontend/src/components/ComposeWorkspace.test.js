import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import i18next from 'i18next';
import {
  attachmentChipView,
  composeHydrationStep,
  composeFormPatch,
  initialComposeForm,
  localDockBounds,
  composeSessionAnnouncement,
  composeSessionCanFocus,
  composeSessionRegionLabel,
  persistComposeDraft,
  reconcileComposeForm,
  replyAllRecipientsForSession,
  uploadFilesSequentially,
} from './composePresentationModel.js';

const source = fs.readFileSync(new URL('./ComposeWorkspace.jsx', import.meta.url), 'utf8');
const modal = fs.readFileSync(new URL('./ComposeModal.jsx', import.meta.url), 'utf8');
const mailApp = fs.readFileSync(new URL('./MailApp.jsx', import.meta.url), 'utf8');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function englishTranslator() {
  const translation = JSON.parse(fs.readFileSync(
    new URL('../locales/en.json', import.meta.url), 'utf8',
  ));
  const instance = i18next.createInstance();
  await instance.init({
    resources: { en: { translation } },
    lng: 'en',
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
  });
  return instance.t.bind(instance);
}

test('mounts one controller-backed workspace at the mail shell boundary', () => {
  assert.match(mailApp, /const ComposeWorkspace = lazy/);
  assert.equal((mailApp.match(/<ComposeWorkspace uiScale=\{scale\}\s*\/>/g) || []).length, 1);
  assert.doesNotMatch(mailApp, /\{composing && <ComposeModal\s*\/>\}/);
  assert.match(mailApp, /data-mail-workspace/);
  assert.match(source, /useComposeWorkspace\(\)/);
});

test('renders only visible snapshots in stable order and lightweight chips separately', () => {
  assert.match(source, /visibleSessions\.map\(session =>/);
  assert.match(source, /visibleSessions\.map\(session => session\.snapshot \?/);
  assert.match(source, /<ComposeModal[\s\S]*key=\{session\.id\}/);
  assert.match(source, /chipSessions\.map\(session =>/);
  assert.match(source, /<ComposeChip/);
  assert.doesNotMatch(source, /@tiptap|CardDAV|ContactPicker/);
});

test('uses a bounded 1/2/3 column dock with local focus styling', () => {
  assert.match(source, /data-compose-capacity=\{capacity\}/);
  assert.match(source, /repeat\(\$\{capacity\}, minmax\(0, 1fr\)\)/);
  assert.match(source, /gap: 12/);
  assert.match(source, /Math\.min\(3, Math\.max\(1/);
  assert.match(source, /focusedSessionId === session\.id/);
  assert.match(source, /var\(--accent\)/);
  assert.match(source, /allowFreeform=\{visibleSessions\.length === 1\}/);
  assert.match(source, /tiled=\{visibleSessions\.length > 1\}/);
});

test('gives the absolute single-composer surface a visible containing block', () => {
  assert.match(source, /position: 'relative'/);
  assert.match(source, /height: visibleSessions\.length === 1 \? 'min\(72vh, 720px\)' : undefined/);
});

test('renders slot 7 region and status labels through i18next without template residue', async () => {
  const t = await englishTranslator();
  const session = { id: 'session-7', slot: 7, subject: 'Synthetic subject', status: 'idle' };
  assert.equal(composeSessionRegionLabel(session, t), 'Draft 7: Synthetic subject');
  assert.equal(composeSessionAnnouncement(session, t), 'Draft 7: Saved');
  assert.doesNotMatch(composeSessionRegionLabel(session, t), /[{}]|<slot>/);
});

test('announces offline and generic persistence errors truthfully and distinctly', async () => {
  const t = await englishTranslator();
  const offline = composeSessionAnnouncement({ id: 'offline', slot: 2, status: 'offline' }, t);
  const error = composeSessionAnnouncement({ id: 'error', slot: 3, status: 'error' }, t);
  assert.equal(offline, 'Draft 2: Offline — changes not saved');
  assert.equal(error, 'Draft 3: Draft could not be saved');
  assert.notEqual(offline, error);
  assert.doesNotMatch(offline, /retry/i);
});

test('guards workspace and modal focus while terminal work is pending', () => {
  assert.equal(composeSessionCanFocus({ id: 'session-7', terminalPending: 'send' }), false);
  assert.equal(composeSessionCanFocus({ id: 'session-7', terminalPending: null }), true);
  assert.match(source, /composeSessionCanFocus\(session\)/);
  assert.match(modal, /if \(!terminalPending\) onFocus\(session\.id\)/);
});

test('constrains the fixed dock to the measured mail workspace rectangle', () => {
  assert.match(source, /querySelector\('\[data-mail-workspace\]'\)/);
  assert.match(source, /getBoundingClientRect\(\)/);
  assert.match(source, /position: 'fixed'/);
  for (const edge of ['top', 'left', 'width', 'height']) {
    assert.match(source, new RegExp(`${edge}: bounds\\.${edge}`));
  }
});

test('delegates all persistence and terminal actions to the controller', () => {
  for (const callback of [
    'changeSession', 'focusSession', 'minimizeSession', 'closeSession',
    'discardSession', 'sendSession', 'addAttachment', 'removeAttachment',
  ]) assert.ok(source.includes(callback), `missing ${callback}`);
  assert.match(source, /onSave=\{\(id, changes\) => saveSession\(id, changes\)\}/);
  assert.match(source, /function safely[\s\S]*console\.error\('Compose action failed'/);
});

test('adapts ComposeModal to a server session without local terminal authority', () => {
  assert.match(modal, /function ComposeModal\(\{[\s\S]*session,[\s\S]*tiled = false,[\s\S]*allowFreeform = false/);
  for (const callback of [
    'onChange', 'onFocus', 'onMinimize', 'onClose', 'onDiscard', 'onSend', 'onUndoQueuedSend',
    'onAddAttachment', 'onRemoveAttachment', 'onSave',
  ]) assert.ok(modal.includes(callback), `missing ${callback}`);
  assert.doesNotMatch(modal, /api\.saveDraft/);
  assert.doesNotMatch(modal, /api\.post\('\/mail\/send'/);
  assert.doesNotMatch(modal, /closeCompose\(/);
  assert.doesNotMatch(modal, /\[minimized, setMinimized\]/);
  assert.match(modal, /dirtyFieldsRef/);
  assert.match(modal, /if \(!hydratedRef\.current\) return/);
  assert.match(modal, /onChange\(session\.id, buildEditablePatch\(\)\)/);
  assert.match(modal, /initialComposeForm\(composeData/);
  assert.match(modal, /reconcileComposeForm\(nextPatch, session, protectedFields\)/);
  assert.match(modal, /uploadFilesSequentially/);
  assert.doesNotMatch(modal, /inReplyTo: composeData\?/);
  assert.doesNotMatch(modal, /references: composeData\?/);
  assert.doesNotMatch(modal, /api\.cancelOutbox/);
  assert.doesNotMatch(modal, /openCompose\(capturedPayload\)/);
  assert.doesNotMatch(modal, /showAttachWarnForDraft|attachWarnDraftCloseAfter|draftHasAttachments/);
});

test('manual Save awaits attachment completion and durable persistence acknowledgement', async () => {
  const persisted = deferred();
  const events = [];
  const changes = {
    subject: 'Complete manual snapshot', body: '<p>Complete body</p>',
    forwardedAttachments: [{ filename: 'forwarded.txt', size: 12 }],
  };
  const saving = persistComposeDraft({
    sessionId: 'session-save', changes,
    waitForAttachments: async action => { events.push('attachments'); return action(); },
    onChange: () => { throw new Error('manual Save must use the flush boundary'); },
    onSave: (id, snapshotValue) => {
      events.push(['save', id, snapshotValue]);
      return persisted.promise;
    },
    onClose: () => { throw new Error('manual Save must not close'); },
    onSavingChange: value => events.push(['saving', value]),
    onError: error => events.push(['error', error]),
  });
  await Promise.resolve();
  assert.deepEqual(events, [
    ['saving', true], 'attachments', ['save', 'session-save', changes],
  ]);
  persisted.resolve('saved');
  assert.equal(await saving, 'saved');
  assert.deepEqual(events.at(-1), ['saving', false]);
});

test('manual Save captures edits after the attachment drain instead of replaying an old snapshot', async () => {
  const attachment = deferred();
  const initialChanges = { subject: 'Before drain', body: '<p>Initial body</p>' };
  let currentChanges = initialChanges;
  const saved = [];
  const saving = persistComposeDraft({
    sessionId: 'session-latest',
    changes: initialChanges,
    getChanges: () => structuredClone(currentChanges),
    waitForAttachments: async action => {
      await attachment.promise;
      return action();
    },
    onSave: async (id, changes) => {
      saved.push([id, changes]);
      return 'saved-latest';
    },
  });
  await Promise.resolve();
  currentChanges = { subject: 'Edited during drain', body: '<p>Latest body</p>' };
  attachment.resolve();

  assert.equal(await saving, 'saved-latest');
  assert.deepEqual(saved, [[
    'session-latest',
    { subject: 'Edited during drain', body: '<p>Latest body</p>' },
  ]]);
});

test('attachment drain waits for mutations appended while an earlier mutation is pending', async () => {
  const presentation = await import('./composePresentationModel.js');
  assert.equal(typeof presentation.runAfterStableAttachmentMutations, 'function');
  const first = deferred();
  const second = deferred();
  let pending = first.promise;
  const events = [];
  const draining = presentation.runAfterStableAttachmentMutations(
    () => pending,
    async () => {
      events.push('saved');
      return 'stable';
    },
  );
  await Promise.resolve();
  pending = first.promise.then(() => second.promise);
  first.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(events, []);
  second.resolve();
  assert.equal(await draining, 'stable');
  assert.deepEqual(events, ['saved']);
});

test('manual Save exposes rejection while reliably clearing the saving state', async () => {
  const failure = new Error('synthetic persistence failure');
  const events = [];
  const result = await persistComposeDraft({
    sessionId: 'session-save', changes: { subject: 'Rejected' },
    waitForAttachments: action => action(),
    onSave: async () => { throw failure; },
    onSavingChange: value => events.push(['saving', value]),
    onError: error => events.push(['error', error]),
  });
  assert.equal(result, null);
  assert.deepEqual(events, [
    ['saving', true], ['error', failure], ['saving', false],
  ]);
});

test('close-after-save drains attachments, captures the final patch, and calls only atomic close', async () => {
  const attachment = deferred();
  const initialChanges = { subject: 'Before close drain', body: '<p>Initial body</p>' };
  let changes = initialChanges;
  const events = [];
  const closing = persistComposeDraft({
    sessionId: 'session-close', changes: initialChanges, getChanges: () => changes,
    closeAfter: true,
    waitForAttachments: async action => {
      events.push('attachments');
      await attachment.promise;
      return action();
    },
    onChange: (id, snapshotValue) => events.push(['change', id, snapshotValue]),
    onSave: () => { throw new Error('close must not pre-flush'); },
    onClose: async id => { events.push(['close', id]); return 'closed'; },
    onSavingChange: value => events.push(['saving', value]),
    onError: error => events.push(['error', error]),
  });
  await Promise.resolve();
  changes = { subject: 'Atomic close', body: '<p>Final body</p>' };
  attachment.resolve();
  const result = await closing;
  assert.equal(result, 'closed');
  assert.deepEqual(events, [
    ['saving', true],
    'attachments',
    ['change', 'session-close', changes],
    ['close', 'session-close'],
    ['saving', false],
  ]);
});

test('manual saving disables attachment additions and removals until the boundary settles', () => {
  assert.match(modal, /savingDraftRef/);
  assert.match(modal, /attachmentControlsDisabled/);
  assert.match(modal, /if \(terminalPending \|\| savingDraftRef\.current\) return/);
  assert.match(modal, /disabled=\{attachmentControlsDisabled\}/);
  assert.match(modal, /<AttachmentChips[\s\S]{0,220}disabled=\{attachmentControlsDisabled\}/);
});

test('keeps freeform drag and resize only for a single composer', () => {
  assert.match(modal, /allowFreeform && !tiled/);
  assert.match(modal, /onPointerDown=\{canFreeform \? handleTitleDragStart : undefined\}/);
  assert.match(modal, /onPointerDown=\{canFreeform \? handleResizeDragStart : undefined\}/);
});

test('routes Android back through safe close for the focused composer', () => {
  assert.match(mailApp, /focusedComposeSessionId/);
  assert.match(mailApp, /composeWorkspaceControllerRef\.current\.closeSession\(sessionId\)/);
  assert.match(mailApp, /handleComposeRequest\(\s*\(\) => composeWorkspaceControllerRef\.current\.closeSession\(sessionId\)/);
  assert.doesNotMatch(mailApp, /closeSession\(sessionId\)\.catch\(\(\) => \{\}\)/);
});

test('uses authoritative body format and preserves quoted HTML in complete patches', () => {
  const rich = initialComposeForm({
    body: '<p>Rich</p>', bodyIsHtml: true, quotedBodyHtml: '<p>Quoted</p>',
    editedSignature: '<p>Custom</p>', to: [], cc: [], bcc: [],
  }, { defaultPlaintext: true });
  assert.equal(rich.bodyIsHtml, true);
  assert.equal(rich.editedSignature, '<p>Custom</p>');

  const plain = initialComposeForm({
    body: 'Plain', bodyIsHtml: false, quotedBodyHtml: '<p>Quoted</p>',
    editedSignature: 'Custom plain', to: [], cc: [], bcc: [],
  }, { defaultPlaintext: false });
  assert.equal(plain.bodyIsHtml, false);
  assert.equal(plain.editedSignature, 'Custom plain');

  const switched = { ...rich, bodyIsHtml: false, body: 'Now plain' };
  const patch = composeFormPatch(switched, { accountId: 'account-synthetic' });
  assert.equal(patch.bodyIsHtml, false);
  assert.equal(patch.body, 'Now plain');
  assert.equal(patch.quotedBodyHtml, '<p>Quoted</p>');
  assert.equal(patch.editedSignature, '<p>Custom</p>');
});

test('reconciles only clean authoritative format and signatures', () => {
  const current = {
    ...initialComposeForm({
      body: 'Local', bodyIsHtml: false, editedSignature: 'Local signature',
      quotedBodyHtml: '<p>Local quote</p>', to: [], cc: [], bcc: [],
    }),
  };
  const remote = {
    body: '<p>Remote</p>', bodyIsHtml: true, editedSignature: '<p>Remote signature</p>',
    quotedBodyHtml: '<p>Remote quote</p>',
  };
  const retained = reconcileComposeForm(current, remote, new Set(['body', 'bodyIsHtml', 'editedSignature']));
  assert.equal(retained.body, 'Local');
  assert.equal(retained.bodyIsHtml, false);
  assert.equal(retained.editedSignature, 'Local signature');
  assert.equal(retained.quotedBodyHtml, '<p>Remote quote</p>');

  const clean = reconcileComposeForm(current, remote, new Set());
  assert.equal(clean.body, '<p>Remote</p>');
  assert.equal(clean.bodyIsHtml, true);
  assert.equal(clean.editedSignature, '<p>Remote signature</p>');
});

test('hydrates a summary-only form atomically before any complete patch can emit', () => {
  let model = composeHydrationStep(undefined, {
    type: 'summary',
    session: {
      id: 'session-synthetic', mode: 'reply', to: [], body: '',
      editedSignature: '', inReplyTo: null, references: [],
    },
  });
  assert.equal(model.ready, false);
  assert.equal(model.emitted, null);
  model = composeHydrationStep(model, {
    type: 'user-change', changes: { subject: 'Must not autosave yet' },
  });
  assert.equal(model.ready, false);
  assert.equal(model.emitted, null);

  const snapshot = {
    id: 'session-synthetic', snapshot: {}, mode: 'reply',
    accountId: 'account-synthetic', aliasId: null,
    to: ['Synthetic Sender <sender@example.com>'], cc: [], bcc: [],
    subject: 'Re: Synthetic', body: '<p>Authoritative reply</p>', bodyIsHtml: true,
    quotedBody: 'Quoted plain', quotedBodyHtml: '<p>Quoted rich</p>',
    editedSignature: '<p>Server signature</p>', forwardedAttachments: [],
    priority: 'normal', inReplyTo: '<synthetic-message>',
    references: ['<synthetic-parent>', '<synthetic-message>'], fromChanged: false,
  };
  model = composeHydrationStep(model, { type: 'snapshot', session: snapshot });
  assert.equal(model.ready, true);
  assert.equal(model.emitted, null);
  assert.equal(model.form.body, '<p>Authoritative reply</p>');
  assert.equal(model.form.bodyIsHtml, true);
  assert.equal(model.form.editedSignature, '<p>Server signature</p>');
  assert.equal(model.form.inReplyTo, '<synthetic-message>');
  assert.deepEqual(model.form.references, ['<synthetic-parent>', '<synthetic-message>']);

  model = composeHydrationStep(model, {
    type: 'user-change', changes: { subject: 'Re: Edited synthetic' }, session: snapshot,
  });
  assert.equal(model.emitted.subject, 'Re: Edited synthetic');
  assert.equal(model.emitted.body, '<p>Authoritative reply</p>');
  assert.equal(model.emitted.editedSignature, '<p>Server signature</p>');
  assert.equal(model.emitted.inReplyTo, '<synthetic-message>');
  assert.deepEqual(model.emitted.references, ['<synthetic-parent>', '<synthetic-message>']);
  assert.deepEqual(Object.keys(model.emitted), [
    'accountId', 'aliasId', 'mode', 'to', 'cc', 'bcc', 'subject', 'body',
    'bodyIsHtml', 'quotedBody', 'quotedBodyHtml', 'editedSignature',
    'forwardedAttachments', 'priority', 'inReplyTo', 'references', 'fromChanged',
  ]);

  model = composeHydrationStep(model, {
    type: 'snapshot',
    session: { ...snapshot, body: '<p>Clean remote update</p>' },
    dirtyFields: new Set(['subject']),
  });
  assert.equal(model.emitted, null);
  assert.equal(model.form.subject, 'Re: Edited synthetic');
  assert.equal(model.form.body, '<p>Clean remote update</p>');
});

test('serializes multi-file uploads in order and stops after a failure', async () => {
  const calls = [];
  await uploadFilesSequentially(['one', 'two', 'three'], async file => {
    calls.push(file);
    await Promise.resolve();
  });
  assert.deepEqual(calls, ['one', 'two', 'three']);

  calls.length = 0;
  await assert.rejects(uploadFilesSequentially(['one', 'two', 'three'], async file => {
    calls.push(file);
    if (file === 'two') throw new Error('synthetic upload failure');
  }), /synthetic upload failure/);
  assert.deepEqual(calls, ['one', 'two']);
});

test('converts scaled viewport geometry to containing-block-local coordinates', () => {
  assert.deepEqual(localDockBounds(
    { top: 120, left: 300, width: 900, height: 600 },
    { top: 60, left: 120 },
    1.5,
  ), { top: 40, left: 120, width: 600, height: 400 });
  assert.deepEqual(localDockBounds(
    { top: 12, left: 24, width: 800, height: 500 },
    { top: 0, left: 0 },
    1,
  ), { top: 12, left: 24, width: 800, height: 500 });
});

test('maps server byteCount to the existing attachment chip size', () => {
  assert.deepEqual(attachmentChipView({
    id: 'attachment-synthetic', filename: 'synthetic.bin', byteCount: 321, mediaType: 'application/octet-stream',
  }), {
    id: 'attachment-synthetic', filename: 'synthetic.bin', byteCount: 321,
    mediaType: 'application/octet-stream', name: 'synthetic.bin', size: 321,
    type: 'application/octet-stream',
  });
});

test('uses durable reply-all metadata and preserves the legacy transition fallback', () => {
  assert.deepEqual(
    replyAllRecipientsForSession({
      replyAllRecipients: ['Synthetic Primary <primary@example.com>'],
      allRecipients: ['Synthetic Legacy <legacy@example.com>'],
    }),
    ['Synthetic Primary <primary@example.com>'],
  );
  assert.deepEqual(
    replyAllRecipientsForSession({ allRecipients: ['Synthetic Legacy <legacy@example.com>'] }),
    ['Synthetic Legacy <legacy@example.com>'],
  );
  assert.match(modal, /composeData\?\.mode === 'reply_all'/);
  assert.equal((modal.match(/replyAllRecipientsForSession\(composeData\)/g) || []).length, 2);
  assert.match(source, /onUndoQueuedSend=\{outboxId => safely\(\(\) => undoQueuedSend\(outboxId\)\)\}/);
});
