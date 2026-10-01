export function headerIds(value) {
  return typeof value === 'string' ? value.match(/<[^<>\s]+>/g) || [] : [];
}

function references(row) {
  return [...headerIds(row?.thread_references), ...headerIds(row?.in_reply_to)];
}

export function replyChainIds(selected, rows) {
  if (!selected?.account_id || headerIds(selected.message_id)[0] !== selected.message_id) return new Set();
  const edges = new Map();
  const node = id => {
    if (!edges.has(id)) edges.set(id, new Set());
    return edges.get(id);
  };
  for (const row of [...rows, selected]) {
    if (row?.account_id !== selected.account_id || row.is_deleted || !row.message_id) continue;
    for (const ref of references(row)) {
      node(row.message_id).add(ref);
      node(ref).add(row.message_id);
    }
  }
  const seen = new Set([selected.message_id]);
  const queue = [...seen];
  for (let i = 0; i < queue.length; i++) {
    for (const next of edges.get(queue[i]) || []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

export function draftFolderPaths(accountId, mappings, folders) {
  const mapped = mappings?.drafts || null;
  const paths = folders.filter(row => row.account_id === accountId && !row.no_select
    && (row.special_use === '\\Drafts' || row.path === mapped)).map(row => row.path);
  return [...new Set(paths)].sort((a, b) =>
    a === mapped ? -1 : b === mapped ? 1 : a.localeCompare(b));
}

export function chooseReplyDraft(selected, conversation, candidates, paths) {
  const folders = new Set(paths);
  const eligible = candidates.filter(row => row.account_id === selected?.account_id
    && folders.has(row.folder) && !row.is_deleted && references(row).length);
  const chain = replyChainIds(selected, [...conversation, ...eligible]);
  return eligible.filter(row => references(row).some(id => chain.has(id)))
    .sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0)
      || Number(b.uid) - Number(a.uid) || String(a.id).localeCompare(String(b.id)))[0] || null;
}

export async function searchReplyDraftUids(client, paths, messageIds) {
  const ids = [...new Set(messageIds.filter(Boolean))];
  if (ids.length > 1000) throw new Error('Reply conversation is too large to check');
  const found = [];
  for (const folder of paths) {
    const lock = await client.getMailboxLock(folder);
    try {
      const uids = new Set();
      for (let i = 0; i < ids.length; i += 20) {
        const terms = ids.slice(i, i + 20).flatMap(id => [
          { header: { 'In-Reply-To': id } }, { header: { References: id } },
        ]);
        const result = await client.search({ or: terms }, { uid: true });
        if (!Array.isArray(result)) throw new Error('Incomplete draft search');
        for (const uid of result) if (Number.isSafeInteger(uid) && uid > 0) uids.add(uid);
        if (uids.size + found.length > 500) throw new Error('Too many reply drafts to check');
      }
      found.push(...[...uids].sort((a, b) => a - b).map(uid => ({ folder, uid })));
    } finally {
      lock.release();
    }
  }
  return found;
}
