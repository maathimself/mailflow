export function commandPaletteShortcut(event, previousEditorPress, now = Date.now()) {
  if (event.isComposing || event.keyCode === 229) {
    return { handled: false, toggle: false, nextEditorPress: previousEditorPress };
  }
  const chord = (event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'k';
  if (!chord || event.isMobile) return { handled: false, toggle: false, nextEditorPress: previousEditorPress };
  if (!event.target?.isContentEditable) return { handled: true, toggle: true, nextEditorPress: null };
  const second = previousEditorPress?.target === event.target && now - previousEditorPress.at <= 1500;
  return second
    ? { handled: true, toggle: true, nextEditorPress: null }
    : { handled: true, toggle: false, nextEditorPress: { target: event.target, at: now } };
}
