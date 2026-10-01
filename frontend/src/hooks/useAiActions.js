import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';
import { BUILTIN_SUMMARIZE, summarizePromptForLocale } from '../aiActions.js';
import { getResults, saveResult, removeResult } from '../aiResults.js';
import { aiRuns } from '../utils/aiRunRegistry.js';

// AI actions on one message, shared by the reading pane and the conversation view (#521).
//
// Results are pinned per message and persisted (#204), so they reappear when the message is
// shown again. A run is not aborted when the message stops being shown: it saves its result
// against the message it started from and only paints while that message is on screen (#428).
// Dismissal, re-running the same action, and an identity change cancel a run.
export function useAiActions(messageId, body) {
  const { t, i18n } = useTranslation();
  const aiActions = useStore(s => s.aiActions);
  const [results, setResults] = useState({});
  const viewingRef = useRef(messageId);

  useEffect(() => {
    viewingRef.current = messageId;
    const saved = getResults(messageId);
    const restored = {};
    for (const [key, r] of Object.entries(saved)) {
      restored[key] = { status: 'done', text: r.text, label: r.label };
    }
    setResults(restored);
  }, [messageId]);

  // Label shown on a result box for a given action key. The built-in summarize key maps to the
  // translated "Summary"; custom actions use their label. Falls back to a stored label, so a
  // result survives its action being deleted.
  const label = useCallback((key, fallback) => {
    if (key === BUILTIN_SUMMARIZE.id) return t('message.summary');
    const found = (aiActions || []).find(a => a.id === key);
    return found?.label || fallback || key;
  }, [aiActions, t]);

  const actionFor = useCallback(key => (key === BUILTIN_SUMMARIZE.id
    ? BUILTIN_SUMMARIZE
    : (aiActions || []).find(a => a.id === key)), [aiActions]);

  // Stream the result into a pinned box. A cached result is shown instantly unless force
  // (Regenerate).
  const run = async (action, { force = false } = {}) => {
    if (!action?.id) return;
    const key = action.id;

    if (!force) {
      if (results[key]?.status === 'done') return;
      const cached = getResults(messageId)[key];
      if (cached) {
        setResults(r => ({ ...r, [key]: { status: 'done', text: cached.text, label: cached.label } }));
        return;
      }
    }

    const textContent = body?.text
      || body?.html?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      || '';
    if (!textContent) return;

    const actionLabel = label(key, action.label);
    const msgId = messageId;
    const ctrl = aiRuns.start(msgId, key, new AbortController());
    const applyIfViewing = (updater) => { if (viewingRef.current === msgId) setResults(updater); };
    applyIfViewing(r => ({ ...r, [key]: { status: 'loading', text: '', label: actionLabel } }));
    // The built-in Summarize prompt is uneditable, so steer its output to the user's UI
    // language (#255). Custom actions keep their author's prompt as-is.
    const promptText = action.builtin ? summarizePromptForLocale(i18n.language) : action.prompt;
    try {
      const fullText = await api.ai.chat([{
        role: 'user',
        content: `${promptText}\n\n${textContent.slice(0, 6000)}`,
      }], {
        signal: ctrl.signal,
        onDelta: (text) => {
          applyIfViewing(r => ({ ...r, [key]: { status: 'loading', text, label: actionLabel } }));
        },
      });
      applyIfViewing(r => ({ ...r, [key]: { status: 'done', text: fullText, label: actionLabel } }));
      // Persist unconditionally: this is the whole point when the user has navigated away.
      if (fullText) saveResult(msgId, key, fullText, actionLabel);
    } catch (err) {
      if (err.name === 'AbortError') return;
      applyIfViewing(r => ({ ...r, [key]: { status: 'error', text: err.message, label: actionLabel } }));
    } finally {
      aiRuns.finish(msgId, key);
    }
  };

  // Dismiss a pinned result and drop its cached copy.
  const dismiss = (key) => {
    aiRuns.abort(messageId, key);
    removeResult(messageId, key);
    setResults(r => { const next = { ...r }; delete next[key]; return next; });
  };

  return { results, run, dismiss, label, actionFor, aiActions };
}
