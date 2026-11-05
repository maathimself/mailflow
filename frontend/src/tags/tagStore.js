// Client-side cache of the tags on messages. Rows ask for their message's tags; lookups made in the
// same tick are batched into one request. `tags_updated` (WebSocket) invalidates and refetches.
import { useEffect } from 'react';
import { create } from 'zustand';
import { api } from '../utils/api.js';

const BATCH_MS = 40;
const MAX_IDS = 200;

export const useTagStore = create(() => ({ byMessage: {}, definitionsRevision: 0 }));

let wanted = new Set();
let timer = null;

async function flush() {
  timer = null;
  const ids = [...wanted];
  wanted = new Set();
  for (let i = 0; i < ids.length; i += MAX_IDS) {
    const chunk = ids.slice(i, i + MAX_IDS);
    try {
      const found = await api.tagsForMessages(chunk);
      const patch = Object.fromEntries(chunk.map((id) => [id, found[id] || []]));
      useTagStore.setState((s) => ({ byMessage: { ...s.byMessage, ...patch } }));
    } catch {
      // Leave them unknown; the next render of the row asks again.
    }
  }
}

export function requestTags(id) {
  if (useTagStore.getState().byMessage[id] !== undefined || wanted.has(id)) return;
  wanted.add(id);
  if (!timer) timer = setTimeout(flush, BATCH_MS);
}

export function invalidateTags(ids) {
  useTagStore.setState((s) => {
    const next = { ...s.byMessage };
    for (const id of ids) delete next[id];
    return { byMessage: next };
  });
  for (const id of ids) requestTags(id);
}

export function clearTagCache() {
  useTagStore.setState({ byMessage: {} });
}

// The tags on one message, fetched (batched) on first use and kept fresh by invalidateTags.
export function useMessageTags(messageId) {
  const tags = useTagStore((s) => s.byMessage[messageId]);
  useEffect(() => { if (messageId) requestTags(messageId); }, [messageId]);
  return tags || [];
}

// The list of tag definitions is fetched by several screens at once (the settings and the picker).
// After a change, call bumpTagDefinitions(); every screen that depends on useTagDefinitionsRevision()
// then reloads, so none shows a stale list.
export const bumpTagDefinitions = () => useTagStore.setState((s) => ({ definitionsRevision: s.definitionsRevision + 1 }));
export const useTagDefinitionsRevision = () => useTagStore((s) => s.definitionsRevision);
