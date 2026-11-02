import { useStore } from '../store/index.js';
import { LAYOUTS, normalizeLayout } from '../layouts.js';
import { useMobile } from './useMobile.js';

// The List first layout on a desktop (#596): the list or one message fills the content area, and
// Back returns to the list. A phone always works this way, so this is false there; code that
// navigates the same way on both checks `isMobile || listFirst`.
export function useListFirst() {
  const isMobile = useMobile();
  const layout = useStore(s => s.layout);
  return !isMobile && Boolean(LAYOUTS[normalizeLayout(layout)].listFirst);
}
