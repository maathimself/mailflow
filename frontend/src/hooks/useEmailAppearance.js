import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { normalizeEmailBodyAppearance } from '../utils/emailBodyAppearance.js';
import { applyEmailMediaMode } from '../utils/emailMediaMode.js';
import { preflightEmailStyles } from '../utils/emailStylePreflight.js';
import { subscribeAppearanceChanges } from '../themes.js';

let automaticEnginePromise;
let testControls = null;
let testInstrumentation = null;
if (import.meta.env.DEV) {
  testInstrumentation = { engineLoads: 0, analyses: 0, commits: 0 };
}

// Test-only seam: production leaves this null. It allows the browser harness to
// drive the real controller through its async boundaries without replacing the
// media/analyzer adapters.
export function setEmailAppearanceTestControls(controls) {
  if (!import.meta.env.DEV) return;
  testControls = controls;
}

function loadAutomaticEngine() {
  if (import.meta.env.DEV && !automaticEnginePromise) testInstrumentation.engineLoads += 1;
  automaticEnginePromise ||= Promise.all([
    import('../utils/emailPalette.js'),
    import('../utils/emailAppearance.js'),
  ]).then(([palette, appearance]) => ({ ...palette, ...appearance }));
  return automaticEnginePromise;
}

function neutralizeRootFilters(root) {
  const documentRoot = root?.nodeType === 9;
  const nodes = documentRoot
    ? [root.documentElement, root.body, root.getElementById('mf-scale-wrapper')]
    : [root];
  for (const node of nodes) {
    if (!node?.style) continue;
    node.style.setProperty('filter', 'none', 'important');
    node.style.setProperty('backdrop-filter', 'none', 'important');
  }
}

function initialDescriptor(desiredMode, messageId, html, stylePreflight) {
  const fallback = desiredMode === 'auto' && stylePreflight.status !== 'ready';
  return {
    renderKey: 0,
    rootKey: 0,
    generation: 1,
    sourceRevision: 0,
    desiredMode,
    renderMode: fallback ? 'original' : desiredMode,
    fallback,
    fallbackReason: fallback ? stylePreflight.reason : undefined,
    status: 'pending',
    readyToken: 0,
    messageId,
    html,
  };
}

export function useEmailAppearance({ messageId, html, preference, themeName }) {
  const stylePreflight = useMemo(() => preflightEmailStyles(html), [html]);
  const themeNameRef = useRef(themeName || 'dark');
  const generationRef = useRef(1);
  const sourceRevisionRef = useRef(0);
  const previousInputRef = useRef({ initialized: false, messageId, html, desiredMode: null });
  const viewOverrideRef = useRef(null);
  const [viewOverride, setViewOverride] = useState(null);
  const descriptorRef = useRef(initialDescriptor(
    normalizeEmailBodyAppearance(preference), messageId, html, stylePreflight,
  ));
  const [, setDescriptorVersion] = useState(0);

  const publish = useCallback(next => {
    descriptorRef.current = next;
    setDescriptorVersion(version => version + 1);
  }, []);

  const startGeneration = useCallback((desiredMode, {
    renderMode = desiredMode,
    freshRoot = false,
    replaceRoot = freshRoot,
    fallback = false,
    fallbackReason,
    sourceRevision = sourceRevisionRef.current,
  } = {}) => {
    const preflightFallback = desiredMode === 'auto' && stylePreflight.status !== 'ready';
    const previous = descriptorRef.current;
    const descriptor = {
      renderKey: previous.renderKey + (freshRoot ? 1 : 0),
      rootKey: previous.rootKey + (replaceRoot ? 1 : 0),
      generation: generationRef.current + 1,
      sourceRevision,
      desiredMode,
      renderMode: preflightFallback ? 'original' : renderMode,
      fallback: fallback || preflightFallback,
      fallbackReason: preflightFallback ? stylePreflight.reason : fallbackReason,
      status: 'pending',
      readyToken: previous.readyToken,
      messageId,
      html,
    };
    generationRef.current = descriptor.generation;
    publish(descriptor);
    return descriptor;
  }, [html, messageId, publish, stylePreflight]);

  const publishTerminal = useCallback((status, generation, evidence = {}) => {
    const current = descriptorRef.current;
    if (generationRef.current !== generation || current.generation !== generation || current.status !== 'pending') {
      return false;
    }
    const terminal = { ...current, status, readyToken: current.readyToken + 1 };
    if (import.meta.env.DEV) terminal.evidence = evidence;
    publish(terminal);
    if (import.meta.env.DEV) console.debug('[email-appearance]', { status, ...evidence });
    return true;
  }, [publish]);

  const rebuildFallback = useCallback((reason, generation) => {
    const current = descriptorRef.current;
    if (generationRef.current !== generation || current.generation !== generation || current.status !== 'pending') {
      return false;
    }
    // Keep the requested appearance (`auto`) separate from the safe recovery
    // renderer (`original`). A later real input can deliberately retry auto.
    startGeneration(current.desiredMode, {
      renderMode: 'original', freshRoot: true, fallback: true,
      fallbackReason: reason,
      sourceRevision: current.sourceRevision,
    });
    if (import.meta.env.DEV) console.debug('[email-appearance]', { status: 'rebuild', reason });
    return false;
  }, [startGeneration]);

  const fallbackCurrentDraft = useCallback((failure, generation, root, styleSheets, deadline, clock) => {
    const current = descriptorRef.current;
    if (generationRef.current !== generation || current.generation !== generation || current.status !== 'pending') {
      return false;
    }
    const evidence = typeof failure === 'string' ? { reason: failure } : failure;
    const reason = evidence?.reason || 'appearance_error';
    // This is deliberately a second selection on the same rule objects. The
    // media adapter's WeakMap restores a partial automatic rewrite first.
    const restored = applyEmailMediaMode({
      root, styleSheets, scheme: 'light', failClosed: true, deadline, clock,
    });
    if (restored.status !== 'ready') return rebuildFallback(restored.reason || reason, generation);
    return publishTerminal('fallback', generation, import.meta.env.DEV
      ? { ...restored, ...evidence, reason }
      : undefined);
  }, [publishTerminal, rebuildFallback]);

  const processDraft = useCallback(async ({ root, styleSheets, recoverySafe = false, rootKey }) => {
    const descriptor = descriptorRef.current;
    const generation = generationRef.current;
    if (!root || descriptor.generation !== generation || descriptor.status !== 'pending' || descriptor.rootKey !== rootKey) return false;

    const controls = import.meta.env.DEV ? testControls : null;
    const clock = controls?.clock || (() => performance.now());
    const startedAt = clock();
    const deadline = startedAt + 100;
    neutralizeRootFilters(root);
    const baseline = applyEmailMediaMode({ root, styleSheets, scheme: 'light', failClosed: true, deadline, clock });
    if (baseline.status !== 'ready') {
      // A recovery shell contains no sender-owned styles and has the marked
      // forced-light base. It is safe to terminalize once that shell is mounted;
      // never start a second recovery generation.
      if (descriptor.fallback && recoverySafe) {
        return publishTerminal('fallback', generation, import.meta.env.DEV ? baseline : undefined);
      }
      return rebuildFallback(baseline.reason, generation);
    }
    if (descriptor.fallback) {
      if (!recoverySafe) return false;
      return publishTerminal('fallback', generation, import.meta.env.DEV
        ? { ...baseline, reason: descriptor.fallbackReason || baseline.reason }
        : undefined);
    }
    if (baseline.removedSheets > 0 || clock() >= deadline) {
      return publishTerminal('fallback', generation, import.meta.env.DEV
        ? { ...baseline, reason: 'baseline_fail_closed' }
        : undefined);
    }
    if (descriptor.renderMode === 'original') return publishTerminal('original', generation);

    let timedOut = false;
    let deadlineFallbackReady = false;
    let commitRollback = null;
    const rollbackCommittedAppearance = () => {
      if (typeof commitRollback !== 'function') return true;
      const rollback = commitRollback;
      commitRollback = null;
      try {
        rollback();
        return true;
      } catch (error) {
        rebuildFallback(error.message || 'email_appearance_rollback_failed', generation);
        return false;
      }
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      // Timer delivery is the semantic deadline signal. A fractional early
      // callback must still take the adapter's expired, owner-removal path.
      deadlineFallbackReady = fallbackCurrentDraft(
        'reveal_deadline', generation, root, styleSheets, deadline, () => deadline,
      );
    }, controls?.revealTimeoutMs ?? Math.max(0, deadline - clock()));
    const current = () => generationRef.current === generation
      && descriptorRef.current.generation === generation
      && descriptorRef.current.status === 'pending'
      && !timedOut;
    const deadlineFallbackIsCurrent = () => {
      const latest = descriptorRef.current;
      return deadlineFallbackReady
        && generationRef.current === generation
        && latest.generation === generation
        && latest.status === 'fallback'
        && latest.rootKey === rootKey
        && latest.sourceRevision === descriptor.sourceRevision;
    };
    const guardDeadline = () => {
      if (!current()) return { stopped: true, result: deadlineFallbackIsCurrent() };
      if (clock() < deadline) return { stopped: false, result: false };
      if (!rollbackCommittedAppearance()) return { stopped: true, result: false };
      deadlineFallbackReady = fallbackCurrentDraft(
        'reveal_deadline', generation, root, styleSheets, deadline, () => deadline,
      );
      return { stopped: true, result: deadlineFallbackIsCurrent() };
    };
    try {
      const context = import.meta.env.DEV ? { generation, root } : null;
      if (import.meta.env.DEV && controls?.checkpoint) {
        await controls.checkpoint('before_engine', context);
        const guarded = guardDeadline();
        if (guarded.stopped) return guarded.result;
      }
      const engine = await (controls?.loadEngine || loadAutomaticEngine)();
      {
        const guarded = guardDeadline();
        if (guarded.stopped) return guarded.result;
      }
      if (import.meta.env.DEV && controls?.checkpoint) {
        await controls.checkpoint('after_engine', { ...context, engine });
        const guarded = guardDeadline();
        if (guarded.stopped) return guarded.result;
      }
      const palette = engine.resolveEmailPalette(document, themeNameRef.current);
      const media = applyEmailMediaMode({ root, styleSheets, scheme: palette.scheme, failClosed: false, deadline, clock });
      if (media.status !== 'ready') return fallbackCurrentDraft(media, generation, root, styleSheets, deadline, clock);
      {
        const guarded = guardDeadline();
        if (guarded.stopped) return guarded.result;
      }
      if (import.meta.env.DEV && controls?.checkpoint) {
        await controls.checkpoint('before_analyze', { ...context, engine, palette });
        const guarded = guardDeadline();
        if (guarded.stopped) return guarded.result;
      }
      if (controls?.throwAt === 'analyze') throw new Error('injected_analyze');
      if (import.meta.env.DEV) testInstrumentation.analyses += 1;
      const analysis = engine.analyzeEmailAppearance(root, palette, {
        ...(controls?.analysisOptions || {}),
        styleSheets,
        deadline,
        clock: controls?.analysisClock || clock,
      });
      {
        const guarded = guardDeadline();
        if (guarded.stopped) return guarded.result;
      }
      if (analysis.status !== 'ready') {
        if (analysis.reason === 'style_complexity_limit') {
          return rebuildFallback(analysis.reason, generation);
        }
        return fallbackCurrentDraft(analysis, generation, root, styleSheets, deadline, clock);
      }
      if (import.meta.env.DEV && controls?.checkpoint) {
        await controls.checkpoint('before_commit', { ...context, engine, palette, analysis });
        const guarded = guardDeadline();
        if (guarded.stopped) return guarded.result;
      }
      if (controls?.throwAt === 'commit') throw new Error('injected_commit');
      if (import.meta.env.DEV) testInstrumentation.commits += 1;
      commitRollback = engine.commitEmailAppearance(analysis, {
        deadline, clock: controls?.commitClock || clock,
      });
      {
        const guarded = guardDeadline();
        if (guarded.stopped) return guarded.result;
      }
      return publishTerminal('themed', generation, import.meta.env.DEV
        ? { ...analysis, themeName: themeNameRef.current, paletteFingerprint: palette.fingerprint }
        : undefined);
    } catch (error) {
      if (!current()) return deadlineFallbackIsCurrent();
      if (!rollbackCommittedAppearance()) return false;
      return error.rollbackFailed
        ? rebuildFallback(error.message, generation)
        : fallbackCurrentDraft(error.message || 'appearance_error', generation, root, styleSheets, deadline, clock);
    } finally {
      clearTimeout(timeout);
    }
  }, [fallbackCurrentDraft, publishTerminal, rebuildFallback]);

  const normalizedPreference = normalizeEmailBodyAppearance(preference);
  const messageInputChanged = descriptorRef.current.messageId !== messageId;
  const desiredMode = messageInputChanged ? normalizedPreference : (viewOverride ?? normalizedPreference);
  useEffect(() => {
    const previous = previousInputRef.current;
    if (!previous.initialized) {
      previousInputRef.current = {
        initialized: true, messageId, html, desiredMode,
      };
      if (desiredMode === 'auto' && stylePreflight.status === 'ready') void loadAutomaticEngine();
      return;
    }
    const messageChanged = previous.initialized && previous.messageId !== messageId;
    const htmlChanged = previous.initialized && previous.html !== html;
    const desiredChanged = previous.initialized && previous.desiredMode !== desiredMode;
    if (messageChanged || htmlChanged || desiredChanged) {
      let nextDesired = desiredMode;
      if (messageChanged) {
        viewOverrideRef.current = null;
        setViewOverride(null);
        nextDesired = normalizedPreference;
      }
      previousInputRef.current = {
        initialized: true, messageId, html, desiredMode: nextDesired,
      };
      startGeneration(nextDesired, {
        freshRoot: !messageChanged && !htmlChanged && desiredChanged,
        replaceRoot: messageChanged || htmlChanged,
      });
      if (nextDesired === 'auto' && stylePreflight.status === 'ready') void loadAutomaticEngine();
    }
  }, [desiredMode, html, messageId, normalizedPreference, startGeneration, stylePreflight]);

  useEffect(() => subscribeAppearanceChanges(({ themeName: notifiedTheme }) => {
    const current = descriptorRef.current;
    themeNameRef.current = notifiedTheme;
    sourceRevisionRef.current += 1;
    previousInputRef.current = {
      initialized: true, messageId: current.messageId, html: current.html, desiredMode: current.desiredMode,
    };
    startGeneration(current.desiredMode, {
      freshRoot: true, sourceRevision: sourceRevisionRef.current,
    });
    if (current.desiredMode === 'auto' && stylePreflight.status === 'ready') void loadAutomaticEngine();
  }), [startGeneration, stylePreflight]);

  const toggleViewMode = useCallback(() => {
    const current = descriptorRef.current;
    const nextDesired = current.desiredMode === 'original' ? 'auto' : 'original';
    viewOverrideRef.current = nextDesired;
    previousInputRef.current = {
      initialized: true, messageId, html, desiredMode: nextDesired,
    };
    startGeneration(nextDesired, { freshRoot: true });
    if (nextDesired === 'auto' && stylePreflight.status === 'ready') void loadAutomaticEngine();
    setViewOverride(nextDesired);
  }, [html, messageId, startGeneration, stylePreflight]);

  const descriptor = descriptorRef.current;
  const inputsMatch = descriptor.messageId === messageId
    && descriptor.html === html
    && descriptor.desiredMode === desiredMode
    && descriptor.sourceRevision === sourceRevisionRef.current;
  const publicStatus = descriptor.status === 'pending' || !inputsMatch ? 'pending' : descriptor.status;
  const pendingPreflightFallback = !inputsMatch
    && desiredMode === 'auto'
    && stylePreflight.status !== 'ready';
  const result = {
    renderKey: descriptor.renderKey,
    rootKey: descriptor.rootKey,
    desiredMode: inputsMatch ? descriptor.desiredMode : desiredMode,
    renderMode: inputsMatch ? descriptor.renderMode : (pendingPreflightFallback ? 'original' : desiredMode),
    recovery: inputsMatch ? descriptor.fallback : pendingPreflightFallback,
    status: publicStatus,
    visibility: publicStatus === 'pending' ? 'hidden' : 'visible',
    readyToken: publicStatus === 'pending' ? null : descriptor.readyToken,
    processDraft,
    toggleViewMode,
  };
  if (import.meta.env.DEV) {
    Object.assign(result, {
      generation: descriptor.generation,
      sourceRevision: descriptor.sourceRevision,
      instrumentation: { ...testInstrumentation },
      evidence: descriptor.evidence,
    });
  }
  return result;
}

export { neutralizeRootFilters };
