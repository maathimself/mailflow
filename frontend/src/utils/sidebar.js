export function collapsedTooltip(label, collapsed) {
  if (!collapsed) return undefined;
  // An empty title suppresses the browser's own tooltip, so drop the attribute.
  return label?.trim() || undefined;
}

export function activateOnKey(activate) {
  return (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault(); // Space would otherwise scroll the page.
    activate();
  };
}

export const FOLDER_ORDER_DRAG_TYPE = 'application/x-mailflow-folder-order';

function delimiterFor(folders) {
  return folders.find(folder => (
    typeof folder?.delimiter === 'string' && folder.delimiter
  ))?.delimiter || '/';
}

function folderParent(path, delimiter) {
  const index = path.lastIndexOf(delimiter);
  return index === -1 ? null : path.slice(0, index);
}

function folderPathsWithAncestors(folders) {
  const delimiter = delimiterFor(folders);
  const paths = new Set();
  for (const folder of folders) {
    if (typeof folder?.path !== 'string' || !folder.path) continue;
    const parts = folder.path.split(delimiter);
    for (let depth = 1; depth <= parts.length; depth += 1) {
      paths.add(parts.slice(0, depth).join(delimiter));
    }
  }
  return [...paths].sort((a, b) => a.localeCompare(b));
}

export function sanitizeFolderOrder(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const clean = {};
  for (const [accountId, paths] of Object.entries(value)) {
    if (!Array.isArray(paths)) continue;
    const seen = new Set();
    const valid = paths.filter(path => {
      if (typeof path !== 'string' || !path || seen.has(path)) return false;
      seen.add(path);
      return true;
    });
    clean[accountId] = valid;
  }
  return clean;
}

export function normalizeFolderOrder(folders, savedOrder = []) {
  const known = folderPathsWithAncestors(Array.isArray(folders) ? folders : []);
  const knownSet = new Set(known);
  const ranked = [];
  const seen = new Set();
  if (Array.isArray(savedOrder)) {
    for (const folderPath of savedOrder) {
      if (
        typeof folderPath !== 'string'
        || seen.has(folderPath)
        || !knownSet.has(folderPath)
      ) continue;
      seen.add(folderPath);
      ranked.push(folderPath);
    }
  }
  return [...ranked, ...known.filter(folderPath => !seen.has(folderPath))];
}

export function buildFolderTree(folders, savedOrder = []) {
  const safeFolders = Array.isArray(folders) ? folders : [];
  const delimiter = delimiterFor(safeFolders);
  const map = {};
  for (const folder of safeFolders) {
    if (typeof folder?.path !== 'string' || !folder.path) continue;
    map[folder.path] = { ...folder, children: [] };
  }

  for (const folder of safeFolders) {
    if (typeof folder?.path !== 'string' || !folder.path) continue;
    const parts = folder.path.split(delimiter);
    for (let depth = 1; depth < parts.length; depth += 1) {
      const folderPath = parts.slice(0, depth).join(delimiter);
      if (!map[folderPath]) {
        map[folderPath] = {
          path: folderPath,
          name: parts[depth - 1],
          delimiter,
          special_use: null,
          account_id: folder.account_id,
          children: [],
        };
      }
    }
  }

  const roots = [];
  const nodes = Object.values(map).sort((a, b) => a.path.localeCompare(b.path));
  for (const node of nodes) {
    const parentPath = folderParent(node.path, delimiter);
    if (parentPath && map[parentPath] && parentPath !== node.path) {
      map[parentPath].children.push(node);
    } else {
      roots.push(node);
    }
  }

  const rank = new Map(
    normalizeFolderOrder(safeFolders, savedOrder)
      .map((folderPath, index) => [folderPath, index]),
  );
  const sortGroup = group => {
    group.sort((a, b) => {
      const aRank = rank.get(a.path);
      const bRank = rank.get(b.path);
      if (aRank != null && bRank != null) return aRank - bRank;
      if (aRank != null) return -1;
      if (bRank != null) return 1;
      return a.path.localeCompare(b.path);
    });
    group.forEach(node => sortGroup(node.children));
  };
  sortGroup(roots);
  return roots;
}

export function reorderFolderPaths(
  folders,
  savedOrder,
  draggedPath,
  targetPath,
  position,
) {
  if (position !== 'before' && position !== 'after') return null;
  const safeFolders = Array.isArray(folders) ? folders : [];
  const delimiter = delimiterFor(safeFolders);
  const current = normalizeFolderOrder(safeFolders, savedOrder);
  const known = new Set(current);
  if (
    draggedPath === targetPath
    || !known.has(draggedPath)
    || !known.has(targetPath)
    || folderParent(draggedPath, delimiter) !== folderParent(targetPath, delimiter)
  ) return null;

  const next = current.filter(folderPath => folderPath !== draggedPath);
  const targetIndex = next.indexOf(targetPath);
  next.splice(targetIndex + (position === 'after' ? 1 : 0), 0, draggedPath);
  return next.every((folderPath, index) => folderPath === current[index])
    ? null
    : next;
}

export function folderDropPosition(clientY, rect) {
  return clientY < rect.top + rect.height / 2 ? 'before' : 'after';
}

export function resolveFolderOrderDrop(
  folders,
  savedOrder,
  dataTransfer,
  targetAccountId,
  targetPath,
  clientY,
  rect,
) {
  if (
    !Array.from(dataTransfer?.types || []).includes(FOLDER_ORDER_DRAG_TYPE)
    || typeof dataTransfer?.getData !== 'function'
  ) return null;

  let drag;
  try {
    drag = JSON.parse(dataTransfer.getData(FOLDER_ORDER_DRAG_TYPE));
  } catch {
    return null;
  }
  if (
    !drag
    || drag.accountId !== targetAccountId
    || typeof drag.path !== 'string'
  ) return null;

  return reorderFolderPaths(
    folders,
    savedOrder,
    drag.path,
    targetPath,
    folderDropPosition(clientY, rect),
  );
}
