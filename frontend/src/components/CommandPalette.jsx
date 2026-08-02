import { useEffect, useMemo, useReducer, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { commandTargetLabel } from '../commands/appContext.js';
import { formatCommandKey } from '../commands/shortcuts.js';
import { createPaletteState, paletteKeyIntent, reducePaletteState } from '../commands/paletteState.js';
import { isRestorableFocus, nextFocusIndex } from '../commands/paletteFocus.js';
import { useCommandRuntimeContext } from '../commands/CommandRuntimeContext.jsx';
import CommandContinuation from './CommandContinuation.jsx';
import CommandIcon from './CommandIcon.jsx';

export default function CommandPalette({ open, onClose }) {
  const { t } = useTranslation();
  const { registry, controller, getContext, continuation, clearContinuation } = useCommandRuntimeContext();
  const [state, dispatch] = useReducer(reducePaletteState, undefined, createPaletteState);
  const inputRef = useRef(null);
  const priorFocusRef = useRef(null);
  const dialogRef = useRef(null);
  const context = getContext();
  const results = useMemo(
    () => registry.search(state.query, context),
    [registry, state.query, context],
  );
  const target = commandTargetLabel(context);

  const resultCount = continuation?.props.items?.length ?? results.length;
  useEffect(() => { dispatch({ type: 'results', count: resultCount }); }, [resultCount]);
  useEffect(() => {
    if (!open) return;
    priorFocusRef.current = document.activeElement;
    dispatch({ type: 'open' });
    queueMicrotask(() => (inputRef.current || dialogRef.current?.querySelector('button'))?.focus());
    return () => {
      const prior = priorFocusRef.current;
      if (isRestorableFocus(prior)) prior.focus();
    };
  }, [open]);
  useEffect(() => { dispatch({ type: 'continuation', value: continuation }); }, [continuation]);
  useEffect(() => {
    if (!open) return;
    dialogRef.current?.querySelectorAll('[role="option"]')[state.activeIndex]
      ?.scrollIntoView({ block: 'nearest' });
  }, [continuation, open, resultCount, state.activeIndex, state.query]);

  if (!open) return null;

  const execute = async result => {
    const outcome = await controller.execute(result.command.id, { source: 'palette' });
    if (['success', 'cancelled', 'partial'].includes(outcome.status)) onClose();
  };
  const onKeyDown = event => {
    const intent = paletteKeyIntent(event);
    if (!intent) {
      if (event.key === 'Tab') {
        const nodes = [...dialogRef.current.querySelectorAll('input,button,[tabindex]:not([tabindex="-1"])')];
        const index = nodes.indexOf(document.activeElement);
        const next = nodes[nextFocusIndex(nodes.length, index, event.shiftKey)];
        event.preventDefault();
        event.stopPropagation();
        next?.focus();
      }
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (intent === 'next') dispatch({ type: 'move', delta: 1 });
    if (intent === 'previous') dispatch({ type: 'move', delta: -1 });
    if (intent === 'execute' && continuation) {
      dialogRef.current.querySelectorAll('[role="option"]')[state.activeIndex]?.click();
    }
    if (intent === 'execute' && !continuation && results[state.activeIndex]) execute(results[state.activeIndex]);
    if (intent === 'back') {
      if (continuation) clearContinuation();
      else onClose();
    }
  };

  return <div className="command-palette__backdrop" onMouseDown={event => event.target === event.currentTarget && onClose()}>
    <section ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="command-palette-title"
      className="command-palette" onKeyDown={onKeyDown}>
      <h2 id="command-palette-title" className="sr-only">{t('commandPalette.title')}</h2>
      <div className="command-palette__search">
        <CommandIcon name="search" />
        {!continuation ? <input
          ref={inputRef} role="combobox" aria-autocomplete="list" aria-expanded="true"
          aria-controls="command-palette-results"
          aria-activedescendant={results[state.activeIndex] ? `command-palette-option-${state.activeIndex}` : undefined}
          value={state.query} onChange={event => dispatch({ type: 'query', query: event.target.value })}
          placeholder={t('commandPalette.placeholder')}
        /> : <strong className="command-palette__continuation-title">
          {t(continuation.props.titleKey)}
        </strong>}
        <kbd className="command-palette__escape">Esc</kbd>
      </div>
      <div aria-live="polite" className="sr-only">
        {t('commandPalette.announcement', { count: continuation?.props.items?.length ?? results.length, target: t(target.key, target.values) })}
      </div>
      {continuation ? <CommandContinuation continuation={continuation} controller={controller}
        activeIndex={state.activeIndex}
        onActiveIndex={index => dispatch({ type: 'move', delta: index - state.activeIndex })}
        onFinished={() => { clearContinuation(); onClose(); }} /> :
        <div role="listbox" id="command-palette-results" className="command-palette__results">
          {results.map((result, index) => <button
            type="button" role="option" id={`command-palette-option-${index}`} key={result.command.id}
            aria-selected={index === state.activeIndex} className="command-palette__row"
            onMouseEnter={() => dispatch({ type: 'move', delta: index - state.activeIndex })}
            onClick={() => execute(result)}
          >
            <span className="command-palette__icon"><CommandIcon name={result.command.icon} /></span>
            <span className="command-palette__copy"><strong>{result.title}</strong>
              {result.matchedAlias && <small>{t('commandPalette.matchedAlias', { alias: result.matchedAlias })}</small>}
            </span>
            {result.bindings[0] && <kbd>{formatCommandKey(result.bindings[0].key, context.platform)}</kbd>}
          </button>)}
          {!results.length && <p className="command-palette__empty">{t('commandPalette.noResults')}</p>}
        </div>}
      <footer className="command-palette__footer">
        <span className="command-palette__target">{t(target.key, target.values)}</span>
        <span className="command-palette__hints" aria-hidden="true">
          <span><kbd>↑↓</kbd>{t('commandPalette.hint.navigate')}</span>
          <span><kbd>↵</kbd>{t('commandPalette.hint.select')}</span>
          <span><kbd>Esc</kbd>{t('commandPalette.hint.close')}</span>
        </span>
      </footer>
    </section>
  </div>;
}
