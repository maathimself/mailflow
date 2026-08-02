import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useComposeWorkspace } from '../hooks/useComposeWorkspace.js';
import ComposeChip from './ComposeChip.jsx';
import ComposeModal from './ComposeModal.jsx';
import {
  composeSessionAnnouncement,
  composeSessionCanFocus,
  composeSessionPersistenceCode,
  composeSessionRegionLabel,
  localDockBounds,
} from './composePresentationModel.js';
import { useCommandRuntimeContext } from '../commands/CommandRuntimeContext.jsx';
import { useComposeShortcuts } from '../hooks/useComposeShortcuts.js';

function safely(action) {
  try {
    const result = action();
    result?.catch?.(error => console.error(
      'Compose action failed', error?.message || String(error),
    ));
    return result;
  } catch (error) {
    console.error('Compose action failed', error?.message || String(error));
    return null;
  }
}

const FIELD_LABEL_KEYS = Object.freeze({
  accountId: 'compose.from',
  aliasId: 'compose.from',
  mode: 'compose.sessions.fields.mode',
  to: 'compose.to',
  cc: 'compose.cc',
  bcc: 'compose.bcc',
  subject: 'compose.subject',
  body: 'compose.sessions.fields.body',
  bodyIsHtml: 'compose.sessions.fields.bodyFormat',
  quotedBody: 'compose.sessions.fields.quoted',
  quotedBodyHtml: 'compose.sessions.fields.quoted',
  editedSignature: 'compose.sessions.fields.signature',
  forwardedAttachments: 'compose.sessions.fields.attachments',
  priority: 'compose.priority',
  inReplyTo: 'compose.sessions.fields.replyContext',
  references: 'compose.sessions.fields.replyContext',
  fromChanged: 'compose.sessions.fields.senderChanged',
});

function useWorkspaceAnnouncement(sessions, focusedSessionId, t) {
  const [announcement, setAnnouncement] = useState('');
  const previousRef = useRef({ statuses: new Map(), focusedSessionId: null, atLimit: false });

  useEffect(() => {
    const previous = previousRef.current;
    const statuses = new Map(sessions.map(session => [session.id, composeSessionPersistenceCode(session)]));
    const atLimit = new Set(sessions.map(session => session.slot)).size >= 9;
    let next = '';

    if (atLimit && !previous.atLimit) {
      next = t('compose.sessions.limit');
    } else if (focusedSessionId && focusedSessionId !== previous.focusedSessionId) {
      next = composeSessionAnnouncement(sessions.find(session => session.id === focusedSessionId), t);
    } else {
      const changed = sessions.find(session => (
        previous.statuses.has(session.id)
        && previous.statuses.get(session.id) !== statuses.get(session.id)
      ));
      if (changed) next = composeSessionAnnouncement(changed, t);
    }

    previousRef.current = { statuses, focusedSessionId, atLimit };
    if (next) setAnnouncement(current => current === next ? current : next);
  }, [focusedSessionId, sessions, t]);

  return announcement;
}

function ConflictBanner({ session, onResolve, t }) {
  const [resolving, setResolving] = useState(false);
  const recovery = Boolean(session.recoveryConflict);
  const fields = recovery
    ? Object.keys(session.recoveryConflict?.recoveredChanges || {})
    : (session.conflict?.conflictingFields || []);
  const labels = [...new Set(
    fields.map(field => FIELD_LABEL_KEYS[field]).filter(Boolean).map(key => t(key)),
  )];
  const blocked = resolving || Boolean(session.terminalPending);
  const resolve = async options => {
    if (blocked) return;
    setResolving(true);
    try {
      await onResolve(session.id, options);
    } catch {
      // The controller preserves the conflict and durable recovery data for retry.
    } finally {
      setResolving(false);
    }
  };

  return (
    <div
      data-compose-conflict={recovery ? 'recovery' : 'server'}
      style={{
        padding: '8px 10px', borderBottom: '1px solid color-mix(in srgb, var(--red) 45%, var(--border))',
        background: 'color-mix(in srgb, var(--red) 9%, var(--bg-secondary))',
        color: 'var(--text-primary)', fontSize: 11, lineHeight: 1.35,
      }}
    >
      <div style={{ fontWeight: 600 }}>
        {t(recovery ? 'compose.sessions.recoveryConflict' : 'compose.sessions.conflict')}
      </div>
      {labels.length > 0 && (
        <div style={{ color: 'var(--text-secondary)', marginTop: 2 }}>
          {t(recovery ? 'compose.sessions.recoveredFields' : 'compose.sessions.conflictingFields', {
            fields: labels.join(', '),
          })}
        </div>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
        <button
          type="button"
          disabled={blocked}
          onClick={() => resolve({ strategy: 'mine' })}
          style={{
            border: '1px solid var(--border)', borderRadius: 5, padding: '3px 8px',
            background: 'var(--bg-elevated)', color: 'var(--text-primary)', cursor: blocked ? 'default' : 'pointer',
          }}
        >
          {t('compose.sessions.keepMine')}
        </button>
        {recovery ? (
          <button
            type="button"
            disabled={blocked}
            onClick={() => resolve({ strategy: 'recovered' })}
            style={{
              border: 'none', borderRadius: 5, padding: '3px 8px',
              background: 'var(--accent)', color: 'var(--accent-text)', cursor: blocked ? 'default' : 'pointer',
            }}
          >
            {t('compose.sessions.useRecovered')}
          </button>
        ) : (
          <button
            type="button"
            disabled={blocked}
            onClick={() => resolve({ strategy: 'remote' })}
            style={{
              border: 'none', borderRadius: 5, padding: '3px 8px',
              background: 'var(--accent)', color: 'var(--accent-text)', cursor: blocked ? 'default' : 'pointer',
            }}
          >
            {t('compose.sessions.useRemote')}
          </button>
        )}
      </div>
    </div>
  );
}

export default function ComposeWorkspace({ uiScale = 1 }) {
  const { t } = useTranslation();
  const [bounds, setBounds] = useState(() => ({
    top: 0, left: 0,
    width: (globalThis.innerWidth || 0) / uiScale,
    height: (globalThis.innerHeight || 0) / uiScale,
  }));
  const {
    sessions, visibleSessions, chipSessions, focusedSessionId, capacity: rawCapacity,
    changeSession, saveSession, focusSession, minimizeSession, restoreSession, closeSession,
    discardSession, sendSession, undoQueuedSend, addAttachment, removeAttachment,
    resolveConflict,
  } = useComposeWorkspace();
  const { controller: commandController, registry, getContext } = useCommandRuntimeContext();
  const capacity = Math.min(3, Math.max(1, rawCapacity || 1));
  const announcement = useWorkspaceAnnouncement(sessions, focusedSessionId, t);
  const atSessionLimit = new Set(sessions.map(session => session.slot)).size >= 9;

  useComposeShortcuts({
    commandController,
    registry,
    getContext,
    getSessions: () => sessions,
    getVisibleSessions: () => visibleSessions,
    getFocusedSessionId: () => focusedSessionId,
  });

  useLayoutEffect(() => {
    const workspaceElement = globalThis.document?.querySelector('[data-mail-workspace]');
    if (!workspaceElement) return undefined;
    const measure = () => {
      const rect = workspaceElement.getBoundingClientRect();
      const containingBlockRect = workspaceElement.parentElement?.getBoundingClientRect?.()
        || { top: 0, left: 0 };
      setBounds(current => {
        const next = localDockBounds(rect, containingBlockRect, uiScale);
        return Object.keys(next).every(key => current[key] === next[key]) ? current : next;
      });
    };
    measure();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    observer?.observe(workspaceElement);
    globalThis.window?.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      globalThis.window?.removeEventListener('resize', measure);
    };
  }, [uiScale]);

  if (!visibleSessions.length && !chipSessions.length) return null;

  return (
    <div
      data-compose-workspace
      style={{
        position: 'fixed', top: bounds.top, left: bounds.left,
        width: bounds.width, height: bounds.height,
        zIndex: 1500, pointerEvents: 'none', overflow: 'hidden',
      }}
    >
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        style={{
          position: 'absolute', width: 1, height: 1, padding: 0, margin: -1,
          overflow: 'hidden', clip: 'rect(0, 0, 0, 0)', whiteSpace: 'nowrap', border: 0,
        }}
      >
        {announcement}
      </div>

      {atSessionLimit && (
        <div
          data-compose-session-limit
          style={{
            position: 'absolute', top: 10, right: 12, maxWidth: 340,
            padding: '6px 10px', border: '1px solid var(--border)', borderRadius: 7,
            background: 'var(--bg-elevated)', color: 'var(--text-secondary)',
            boxShadow: 'var(--shadow-sm)', fontSize: 11, pointerEvents: 'auto',
          }}
        >
          {t('compose.sessions.limit')}
        </div>
      )}

      {visibleSessions.length > 0 && (
        <div
          data-compose-capacity={capacity}
          style={{
            position: 'absolute', left: 12, right: 12, bottom: 54,
            display: 'grid', gridTemplateColumns: `repeat(${capacity}, minmax(0, 1fr))`,
            gap: 12, alignItems: 'end', pointerEvents: 'none',
          }}
        >
          {visibleSessions.map(session => session.snapshot ? (() => {
            const titleId = `compose-session-title-${session.id}`;
            return (
              <div
                key={session.id}
                role="region"
                aria-labelledby={titleId}
                data-compose-session={session.id}
                data-compose-session-id={session.id}
                data-compose-focused={focusedSessionId === session.id ? 'true' : 'false'}
                style={{
                  position: 'relative',
                  height: visibleSessions.length === 1 ? 'min(72vh, 720px)' : undefined,
                  minWidth: 0, pointerEvents: 'auto', borderRadius: 11,
                  outline: focusedSessionId === session.id ? '2px solid var(--accent)' : '2px solid transparent',
                  outlineOffset: 2, overflow: 'hidden', background: 'var(--bg-secondary)',
                }}
                onPointerDown={() => {
                  if (composeSessionCanFocus(session)) focusSession(session.id);
                }}
              >
                <h2
                  id={titleId}
                  style={{
                    position: 'absolute', width: 1, height: 1, padding: 0, margin: -1,
                    overflow: 'hidden', clip: 'rect(0, 0, 0, 0)', whiteSpace: 'nowrap', border: 0,
                  }}
                >
                  {composeSessionRegionLabel(session, t)}
                </h2>
                {(session.conflict || session.recoveryConflict) && (
                  <ConflictBanner session={session} onResolve={resolveConflict} t={t} />
                )}
                <ComposeModal
                  session={session}
                  tiled={visibleSessions.length > 1}
                  allowFreeform={visibleSessions.length === 1}
                  onChange={changeSession}
                  onSave={(id, changes) => saveSession(id, changes)}
                  onFocus={id => {
                    if (composeSessionCanFocus(session)) focusSession(id);
                  }}
                  onMinimize={id => safely(() => minimizeSession(id))}
                  onClose={id => safely(() => closeSession(id))}
                  onDiscard={id => safely(() => discardSession(id))}
                  onSend={(id, options) => safely(() => sendSession(id, options))}
                  onUndoQueuedSend={outboxId => safely(() => undoQueuedSend(outboxId))}
                  onAddAttachment={(id, file) => safely(() => addAttachment(id, file))}
                  onRemoveAttachment={(id, attachmentId) => safely(() => removeAttachment(id, attachmentId))}
                />
              </div>
            );
          })() : null)}
        </div>
      )}

      {chipSessions.length > 0 && (
        <div style={{
          position: 'absolute', right: 12, bottom: 12,
          display: 'flex', flexDirection: 'row-reverse', gap: 8,
          maxWidth: 'calc(100vw - 24px)', pointerEvents: 'auto', overflow: 'hidden',
        }}>
          {chipSessions.map(session => (
            <ComposeChip
              key={session.id}
              session={session}
              onRestore={id => safely(() => restoreSession(id))}
              onFocus={id => {
                if (composeSessionCanFocus(session)) focusSession(id);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
