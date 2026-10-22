import { useStore } from '../store/index.js';
import { api } from './api.js';

// Message bodies already fetched, shared by the reading pane and the conversation cards and filled
// ahead by prefetching, so opening a message seen or prefetched shows it at once. The least
// recently used go first, past 50 bodies or about 40 MB of text (a body carries its inline images
// as data: URIs). Emptied whenever the signed-in user changes: it holds their mail.
const LIMIT = 50;
const MAX_CHARS = 40 * 1024 * 1024;
const entries = new Map();
let chars = 0;

const sizeOf = body => (body?.html?.length || 0) + (body?.text?.length || 0) + (body?.darkCss?.length || 0);

function remove(id) {
  const body = entries.get(id);
  if (!body) return;
  entries.delete(id);
  chars -= sizeOf(body);
}

export const bodyCache = {
  // The body, now the most recently used.
  get(id) {
    const body = entries.get(id);
    if (body) {
      entries.delete(id);
      entries.set(id, body);
    }
    return body;
  },
  has: id => entries.has(id),
  set(id, body) {
    if (!id || !(body?.html || body?.text)) return;
    remove(id);
    entries.set(id, body);
    chars += sizeOf(body);
    while (entries.size > LIMIT || (chars > MAX_CHARS && entries.size > 1)) remove(entries.keys().next().value);
  },
  delete: remove,
  // Drops every entry `drop(body, id)` picks. Returns whether any went.
  evict(drop) {
    let any = false;
    for (const [id, body] of [...entries]) {
      if (drop(body, id)) {
        remove(id);
        any = true;
      }
    }
    return any;
  },
  clear() {
    entries.clear();
    chars = 0;
  },
};

// Loads a body into the cache ahead of its opening, once. A failure is left for the opening to
// meet: it fetches again with its own retries.
export function prefetchBody(id, remoteImages = false) {
  if (!id || entries.has(id)) return;
  api.getMessageBody(id, remoteImages).then(data => bodyCache.set(id, data)).catch(() => {});
}

let cachedFor = useStore.getState().user?.id ?? null;
useStore.subscribe((state) => {
  const id = state.user?.id ?? null;
  if (id !== cachedFor) {
    cachedFor = id;
    bodyCache.clear();
  }
});
