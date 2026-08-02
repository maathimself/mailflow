export function createPaletteState() {
  return { query: '', activeIndex: 0, resultCount: 0, continuation: null };
}

export function paletteKeyIntent(event) {
  if (event.isComposing || event.nativeEvent?.isComposing || event.keyCode === 229 || event.nativeEvent?.keyCode === 229) {
    return null;
  }
  const key = event.key.toLowerCase();
  if (event.key === 'ArrowDown' || (event.ctrlKey && (key === 'n' || key === 'j'))) return 'next';
  if (event.key === 'ArrowUp' || (event.ctrlKey && (key === 'p' || key === 'k'))) return 'previous';
  if (event.key === 'Enter') return 'execute';
  if (event.key === 'Escape') return 'back';
  return null;
}

export function reducePaletteState(state, event) {
  switch (event.type) {
    case 'open': return { ...createPaletteState(), resultCount: state.resultCount };
    case 'query': return { ...state, query: event.query, activeIndex: 0 };
    case 'results': return { ...state, resultCount: event.count, activeIndex: Math.min(state.activeIndex, Math.max(0, event.count - 1)) };
    case 'move': return { ...state, activeIndex: Math.max(0, Math.min(state.resultCount - 1, state.activeIndex + event.delta)) };
    case 'continuation': return { ...state, continuation: event.value, query: '', activeIndex: 0 };
    case 'back': return state.continuation
      ? { ...state, continuation: null, query: '', activeIndex: 0 }
      : state;
    default: return state;
  }
}
