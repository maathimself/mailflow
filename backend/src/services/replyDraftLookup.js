export function headerIds(value) {
  return typeof value === 'string' ? value.match(/<[^<>\s]+>/g) || [] : [];
}

function references(row) {
  return [...headerIds(row?.thread_references), ...headerIds(row?.in_reply_to)];
}

const validId = row => row?.account_id && row.message_id
  && headerIds(row.message_id)[0] === row.message_id;

function accountEdges(graph, accountId) {
  if (!graph.has(accountId)) graph.set(accountId, new Map());
  return graph.get(accountId);
}

function addEdges(graph, row, refs) {
  if (!validId(row) || row.is_deleted) return;
  const edges = accountEdges(graph, row.account_id);
  const node = id => {
    if (!edges.has(id)) edges.set(id, new Set());
    return edges.get(id);
  };
  node(row.message_id);
  for (const ref of refs) {
    node(row.message_id).add(ref);
    node(ref).add(row.message_id);
  }
}

export function createReplyGraph(rows) {
  const graph = new Map();
  for (const row of rows) {
    if (validId(row) && !row.is_deleted) addEdges(graph, row, references(row));
  }
  return graph;
}

function walk(edges, start, seen, visit = () => {}) {
  if (seen.has(start)) return;
  seen.add(start);
  visit(start);
  const queue = [start];
  for (let i = 0; i < queue.length; i++) {
    for (const next of edges?.get(queue[i]) || []) {
      if (seen.has(next)) continue;
      seen.add(next);
      visit(next);
      queue.push(next);
    }
  }
}

export function replyChainIdsFor(graph, members) {
  const result = new Map();
  for (const member of members) {
    if (!validId(member) || member.is_deleted) continue;
    if (!result.has(member.account_id)) result.set(member.account_id, new Set());
    walk(graph.get(member.account_id), member.message_id, result.get(member.account_id));
  }
  return result;
}

export function replyChainIds(selected, rows) {
  if (!validId(selected)) return new Set();
  return replyChainIdsFor(createReplyGraph([...rows, selected]), [selected]).get(selected.account_id) || new Set();
}

export function draftFolderPaths(accountId, mappings, folders) {
  const mapped = mappings?.drafts || null;
  const paths = folders.filter(row => row.account_id === accountId && !row.no_select
    && (row.special_use === '\\Drafts' || row.path === mapped)).map(row => row.path);
  return [...new Set(paths)].sort((a, b) =>
    a === mapped ? -1 : b === mapped ? 1 : a.localeCompare(b));
}

export function chooseReplyDraft(selected, conversation, candidates, paths) {
  if (!validId(selected)) return null;
  const byAccount = new Map([[selected.account_id, paths]]);
  const eligible = eligibleDrafts(candidates, byAccount);
  if (!eligible.length) return null;
  return draftIndex(createReplyGraph([...conversation, selected]), eligible)
    .get(selected.account_id)?.get(selected.message_id) || null;
}

function eligibleDrafts(candidates, pathsByAccount) {
  const folders = new Map([...pathsByAccount].map(([id, paths]) => [id, new Set(paths)]));
  return candidates.filter(row => !row.is_deleted && folders.get(row.account_id)?.has(row.folder))
    .map(row => ({ row, refs: references(row) })).filter(candidate => candidate.refs.length);
}

function preferredDraft(a, b) {
  if (!a) return b;
  if (!b) return a;
  const rank = (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0)
    || Number(b.uid) - Number(a.uid) || String(a.id).localeCompare(String(b.id));
  return rank <= 0 ? a : b;
}

function componentIndex(graph) {
  const accounts = new Map();
  const node = (accountId, id) => {
    if (!accounts.has(accountId)) accounts.set(accountId, new Map());
    const nodes = accounts.get(accountId);
    if (!nodes.has(id)) {
      const value = { parent: null, size: 1, best: null };
      value.parent = value;
      nodes.set(id, value);
    }
    return nodes.get(id);
  };
  const root = value => {
    while (value.parent !== value) {
      value.parent = value.parent.parent;
      value = value.parent;
    }
    return value;
  };
  const connect = (left, right) => {
    let a = root(left), b = root(right);
    if (a === b) return;
    if (a.size < b.size) [a, b] = [b, a];
    b.parent = a;
    a.size += b.size;
    a.best = preferredDraft(a.best, b.best);
    b.best = null;
  };
  for (const [accountId, edges] of graph) {
    for (const [id, refs] of edges) {
      const own = node(accountId, id);
      for (const ref of refs) connect(own, node(accountId, ref));
    }
  }
  return {
    add(eligible) {
      for (const { row, refs } of eligible) {
        // A later page may join components whose newest draft was on an earlier
        // page. Keep that winner on the root, independently of scan order.
        if (validId(row)) {
          const own = node(row.account_id, row.message_id);
          for (const ref of refs) connect(own, node(row.account_id, ref));
          const component = root(own);
          component.best = preferredDraft(component.best, row);
        } else {
          // Missing own IDs can nominate a draft in several components but must
          // not join them and make other candidates match unrelated messages.
          for (const ref of refs) {
            const component = root(node(row.account_id, ref));
            component.best = preferredDraft(component.best, row);
          }
        }
      }
    },
    result(members) {
      const index = new Map();
      const include = (accountId, id) => {
        const value = accounts.get(accountId)?.get(id);
        const best = value && root(value).best;
        if (!best) return;
        if (!index.has(accountId)) index.set(accountId, new Map());
        index.get(accountId).set(id, best);
      };
      if (members) {
        for (const member of members) if (validId(member) && !member.is_deleted) include(member.account_id, member.message_id);
      } else {
        for (const [accountId, nodes] of accounts) for (const id of nodes.keys()) include(accountId, id);
      }
      return index;
    },
  };
}

function draftIndex(graph, eligible) {
  const index = componentIndex(graph);
  index.add(eligible);
  return index.result();
}

// Process bounded database pages without sorting the whole Drafts folder.
// Keep each component's best candidate as later pages add connections.
export function createReplyDraftIndex(graph, pathsByAccount) {
  const index = componentIndex(graph);
  return {
    add: candidates => index.add(eligibleDrafts(candidates, pathsByAccount)),
    result: members => index.result(members),
  };
}

export function indexReplyDrafts(graph, candidates, pathsByAccount) {
  return draftIndex(graph, eligibleDrafts(candidates, pathsByAccount));
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
