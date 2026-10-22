import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '../store/index.js';
import { api } from '../utils/api.js';
import { BUILTIN_SUMMARIZE, buildAiActionContent, summarizePromptForLocale } from '../aiActions.js';
import { getResults, saveResult, removeResult } from '../aiResults.js';
import { aiMessageText } from '../utils/aiMessageText.js';
import { aiRuns } from '../utils/aiRunRegistry.js';

// AI actions on one message, shared by the reading pane and the conversation view (#521).
//
// Results are pinned per message and persisted (#204), so they reappear when the message
// is shown again. A run is not aborted when the message stops being shown: it saves its
// result against the message it started from and only paints while that message is on
// screen (#428). Dismissal, re-running the same action, and an identity change cancel a run.
// The envelope subject reaches the built-in action: an Outlook forward has no marker in
// the body, and "Fwd:" on the subject is what tells it from a reply (#647 review).
export function useAiActions(messageId, body, subject) {
  const { t, i18n } = useTranslation();
  const aiActions = useStore(s => s.aiActions);
  const [results, setResults] = useState({});
  const viewingRef = useRef(messageId);

  useEffect(() => {
    viewingRef.current = messageId;
    const saved = getResults(messageId);
    const restored = {};
    for (const [key, r] of Object.entries(saved)) {
      restored[key] = { status: 'done', text: r.text, label: r.label, truncated: r.truncated || null };
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
        setResults(r => ({ ...r, [key]: { status: 'done', text: cached.text, label: cached.label, truncated: cached.truncated || null } }));
        return;
      }
    }

    // The model reads what the user reads: the visible text of the message, without CSS
    // or bare URLs (#646). The built-in action also gets trailing quoted history cut;
    // custom actions are sent whole — their prompts may need the thread and the links,
    // and cutting is lossy on forwards and inline replies (#647 review). aiMessageText
    // subsumes the linear-time stripTags of 1903651: extraction is DOMParser-based,
    // linear on hostile input, and leaves no tag debris or CSS either.
    const textContent = aiMessageText(body, { full: !action.builtin, subject });
    if (!textContent) return;

    const actionLabel = label(key, action.label);
    const msgId = messageId;
    const ctrl = aiRuns.start(msgId, key, new AbortController());
    const applyIfViewing = (updater) => { if (viewingRef.current === msgId) setResults(updater); };
    applyIfViewing(r => ({ ...r, [key]: { status: 'loading', text: '', label: actionLabel } }));
    // The built-in Summarize prompt is uneditable, so steer its output to the user's UI
    // language (#255). Custom actions keep their author's prompt as-is.
    const promptText = action.builtin ? summarizePromptForLocale(i18n.language) : action.prompt;
    // A body too long for one request is cut, and the box says so (#633).
    const { content, truncated } = buildAiActionContent(promptText, textContent);
    try {
      const fullText = await api.ai.chat([{ role: 'user', content }], {
        purpose: 'summarize',
        signal: ctrl.signal,
        onDelta: (text) => {
          applyIfViewing(r => ({ ...r, [key]: { status: 'loading', text, label: actionLabel, truncated } }));
        },
      });
      applyIfViewing(r => ({ ...r, [key]: { status: 'done', text: fullText, label: actionLabel, truncated } }));
      // Persist unconditionally: this is the whole point when the user has navigated away.
      if (fullText) saveResult(msgId, key, fullText, actionLabel, truncated);
    } catch (err) {
      if (err.name === 'AbortError') return;
      // Refused: AI is off for this user, or summaries are off for everyone (#644).
      const text = err.code === 'ai_user_disabled' ? t('message.aiNotAllowed')
        : err.code === 'ai_feature_disabled' ? t('message.aiFeatureOff')
          : err.message;
      applyIfViewing(r => ({ ...r, [key]: { status: 'error', text, label: actionLabel } }));
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
