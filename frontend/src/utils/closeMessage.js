import { useStore } from '../store/index.js';

// Back from an open message to the list, on a phone and in List first (#596). Opening a message
// there pushes a history entry, so Back pops it and popstate closes the message. A message can be
// open without that entry: opened before switching to List first, or restored after unlocking.
// history.back() would then leave MailFlow, so the message is closed directly instead.
export function closeOpenMessage() {
  if (typeof history !== 'undefined' && history.state?.mailflow === 'message') history.back();
  else useStore.getState().setSelectedMessage(null);
}
