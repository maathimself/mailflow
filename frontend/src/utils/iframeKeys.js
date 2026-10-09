// HTML email renders in its own iframe document, so a key pressed after clicking into the body
// never reaches the page's shortcut listener on document (#537). MessageBodyView calls this from
// a keydown listener inside the frame: it re-dispatches the press on the page's document as a
// fresh event with the same key and modifiers, and cancels the original when a page handler
// cancelled the copy, so a bound key does not also act inside the frame.
//
// The copy's target is the page's document, not an element, which every page-level handler
// already treats as "not typing". Typing into a field inside the frame stays in the frame: the
// sanitizer strips form fields from email, but the check costs nothing if one ever gets through.
export function forwardIframeKeydown(event, targetDocument) {
  if (!event || !targetDocument || event.isComposing || event.defaultPrevented) return false;
  const el = event.target;
  const tag = el?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable) return false;
  const KeyboardEventCtor = targetDocument.defaultView?.KeyboardEvent;
  if (!KeyboardEventCtor) return false;
  const copy = new KeyboardEventCtor('keydown', {
    key: event.key, code: event.code, location: event.location, repeat: event.repeat,
    ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey, shiftKey: event.shiftKey,
    bubbles: true, cancelable: true,
  });
  if (!targetDocument.dispatchEvent(copy)) event.preventDefault();
  return true;
}
