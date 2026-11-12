import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// Move the host rather than remounting the input: query, selection and focus survive a
// header target becoming available, and the search stays visible behind an open reader.
export default function SearchPlacement({ target, children }) {
  const placeholder = useRef(null);
  const [host] = useState(() => document.createElement('div'));
  useLayoutEffect(() => {
    const focused = host.contains(document.activeElement) ? document.activeElement : null;
    const selection = focused && typeof focused.selectionStart === 'number'
      ? [focused.selectionStart, focused.selectionEnd, focused.selectionDirection] : null;
    (target || placeholder.current).appendChild(host);
    focused?.focus({ preventScroll: true });
    if (selection) focused.setSelectionRange(...selection);
  }, [host, target]);
  useLayoutEffect(() => () => host.remove(), [host]);
  return <><div ref={placeholder} className="mail-search-placeholder" />{createPortal(children, host)}</>;
}
