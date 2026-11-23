import { useStore } from '../store/index.js';
import { useMobile } from './useMobile.js';
import { useListFirst } from './useListFirst.js';
import { undoBarHost } from '../utils/undoBarHost.js';

// 'list', 'floating' or null (a phone): see utils/undoBarHost.js.
export function useUndoBarHost() {
  const isMobile = useMobile();
  const listFirst = useListFirst();
  const showContacts = useStore(s => s.showContacts);
  const messageOpen = useStore(s => Boolean(s.selectedMessageId));
  return undoBarHost({ isMobile, listFirst, showContacts, messageOpen });
}
