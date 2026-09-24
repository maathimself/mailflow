function headerIds(value) {
  return typeof value === 'string' ? value.match(/<[^<>\s]+>/g) || [] : [];
}

function references(row) {
  return [...headerIds(row?.thread_references), ...headerIds(row?.in_reply_to)];
}

export function replyChainIds(selected, rows) {
  if (!selected?.message_id || !selected?.account_id) return new Set();
  const pool = [...rows, selected].filter(row => row?.account_id === selected.account_id && row.message_id);
  const adj = new Map(pool.map(row => [row.message_id, new Set()]));
  for (const row of pool) {
    for (const ref of references(row)) {
      if (!adj.has(ref)) continue;
      adj.get(row.message_id).add(ref);
      adj.get(ref).add(row.message_id);
    }
  }
  const seen = new Set([selected.message_id]);
  const queue = [selected.message_id];
  for (let i = 0; i < queue.length; i++) {
    for (const next of adj.get(queue[i]) || []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

export async function draftFolderPaths(accountId, folderMappings, queryFn) {
  const mapped = folderMappings?.drafts || null;
  const { rows } = await queryFn(
    `SELECT path FROM folders WHERE account_id = $1 AND COALESCE(no_select, false) = false
     AND (special_use = '\\Drafts' OR path = $2)`,
    [accountId, mapped]
  );
  return [...new Set(rows.map(row => row.path))].sort((a, b) => {
    if (a === mapped) return -1;
    if (b === mapped) return 1;
    return a.localeCompare(b);
  });
}

export function chooseReplyDraft(selected, conversationRows, candidateRows, paths) {
  if (!selected?.message_id) return null;
  const folderSet = new Set(paths);
  const candidates = candidateRows.filter(row =>
    row?.account_id === selected.account_id && folderSet.has(row.folder) && !row.is_deleted
    && references(row).length > 0
  );
  const chain = replyChainIds(selected, [...conversationRows, ...candidates]);
  return candidates.filter(row => references(row).some(ref => chain.has(ref)))
    .sort((a, b) => {
      const dates = (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0);
      if (dates) return dates;
      const uids = Number(b.uid) - Number(a.uid);
      return uids || String(a.id).localeCompare(String(b.id));
    })[0] || null;
}

export async function searchReplyDraftUids(client, paths, messageIds) {
  const ids = [...new Set(messageIds.filter(Boolean))];
  if (!ids.length || !paths.length) return [];
  const found = [];
  for (const folder of paths) {
    const lock = await client.getMailboxLock(folder);
    try {
      const folderUids = new Set();
      for (let i = 0; i < ids.length; i += 20) {
        const terms = ids.slice(i, i + 20).flatMap(id => [
          { header: { 'In-Reply-To': id } },
          { header: { References: id } },
        ]);
        const uids = await client.search({ or: terms }, { uid: true });
        if (!Array.isArray(uids)) throw new Error('Incomplete draft search');
        for (const uid of uids) if (Number.isSafeInteger(uid) && uid > 0) folderUids.add(uid);
      }
      found.push(...[...folderUids].sort((a, b) => a - b).map(uid => ({ folder, uid })));
    } finally {
      lock.release();
    }
  }
  return found;
}
