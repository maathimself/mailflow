import { useTranslation } from 'react-i18next';

export default function CommandContinuation({ continuation, controller, onFinished, activeIndex, onActiveIndex }) {
  const { t } = useTranslation();
  const items = continuation.props.items || [];
  const choose = async item => {
    const outcome = await controller.execute(continuation.commandId, {
      source: 'palette',
      input: { [continuation.props.inputKey || 'value']: item.id },
      frozenTargetIds: continuation.targetIds,
    });
    if (['success', 'cancelled', 'partial'].includes(outcome.status)) onFinished(outcome);
  };
  return <div role="listbox" id="command-palette-results" className="command-palette__results"
    aria-label={t(continuation.props.titleKey)}>
    {items.map((item, index) => <button
      type="button" role="option" aria-selected={index === activeIndex} key={item.id}
      className="command-palette__row" onMouseEnter={() => onActiveIndex(index)} onClick={() => choose(item)}
    >
      <span>{item.label}</span>
      {item.description && <small>{item.description}</small>}
    </button>)}
  </div>;
}
