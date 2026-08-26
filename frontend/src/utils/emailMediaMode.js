const COLOR_SCHEME_TERM = /\(\s*prefers-color-scheme\s*:\s*(dark|light)\s*\)/gi;
const ALWAYS = '(min-width: 0px)';
const NEVER = '(max-width: -1px)';
const authoredMediaConditions = new WeakMap();

function selectedCondition(conditionText, scheme) {
  return conditionText.replace(COLOR_SCHEME_TERM, (_term, authored) => (
    authored.toLowerCase() === scheme ? ALWAYS : NEVER
  ));
}

function getAuthoredCondition(rule, conditionText) {
  const cached = authoredMediaConditions.get(rule);
  if (cached !== undefined) return cached;
  authoredMediaConditions.set(rule, conditionText);
  return conditionText;
}

function collectionLength(collection) {
  return collection.length;
}

function collectionItem(collection, index) {
  return typeof collection.item === 'function' ? collection.item(index) : collection[index];
}

function ownerIsBase(owner) {
  return owner?.hasAttribute?.('data-mailflow-email-base')
    || owner?.dataset?.mailflowEmailBase !== undefined;
}

function removeSenderSheet(sheet, removedOwners) {
  const owner = sheet?.ownerNode;
  if (!owner || ownerIsBase(owner)) return 'unremovable';
  if (removedOwners.has(owner)) return 'already_removed';
  owner.remove();
  removedOwners.add(owner);
  return 'removed';
}

function hasRemovableSenderOwner(sheet) {
  const owner = sheet?.ownerNode;
  return Boolean(owner && !ownerIsBase(owner));
}

function rootFor(root) {
  return root?.nodeType === 9 ? root.documentElement : root;
}

function setRootMode(root, scopedRoot, scheme) {
  const attributeRoots = root?.nodeType === 9
    ? [scopedRoot, root.body].filter((element, index, elements) => (
      element && elements.indexOf(element) === index
    ))
    : [scopedRoot];
  for (const element of attributeRoots) {
    if (scheme === 'dark') {
      element.setAttribute('data-ogsc', '');
      element.setAttribute('data-ogsb', '');
    } else {
      element.removeAttribute('data-ogsc');
      element.removeAttribute('data-ogsb');
    }
    element.style.setProperty('color-scheme', scheme, 'important');
  }
}

export function applyEmailMediaMode({
  root,
  styleSheets,
  scheme,
  failClosed = false,
  deadline = Infinity,
  maxRules = 5000,
  maxConditionChars = 32768,
  clock = () => performance.now(),
}) {
  const fallback = reason => ({ status: 'fallback', reason });
  let scopedRoot;
  try {
    scopedRoot = rootFor(root);
  } catch {
    return fallback('media_rule_unwritable');
  }
  if (!scopedRoot || !['dark', 'light'].includes(scheme)) {
    return fallback('media_root_invalid');
  }

  try {
    setRootMode(root, scopedRoot, scheme);
  } catch {
    return fallback('media_rule_unwritable');
  }

  const sheets = styleSheets || [];
  const removedOwners = new Set();
  let rewrites = 0;
  let visitedRules = 0;
  let visitedSheets = 0;
  let removedSheets = 0;
  let conditionChars = 0;

  const ready = () => ({ status: 'ready', rewrites, removedSheets, visitedRules });

  const failClosedRemaining = (startIndex, includeProcessed = false) => {
    let sheetCount;
    try {
      sheetCount = collectionLength(sheets);
      const firstIndex = includeProcessed ? 0 : startIndex;
      for (let index = sheetCount - 1; index >= firstIndex; index -= 1) {
        const sheet = collectionItem(sheets, index);
        const owner = sheet?.ownerNode;
        if (!owner || ownerIsBase(owner) || removedOwners.has(owner)) continue;
        const removal = removeSenderSheet(sheet, removedOwners);
        if (removal === 'unremovable') return false;
        if (removal === 'removed') removedSheets += 1;
      }
    } catch {
      return false;
    }
    return true;
  };

  const checkBudget = () => {
    if (visitedRules > maxRules) return 'media_rule_limit';
    if (visitedRules % 64 === 0 && clock() >= deadline) return 'media_deadline';
    return null;
  };

  const checkSheetDeadline = () => (
    visitedSheets % 64 === 0 && clock() >= deadline ? 'media_deadline' : null
  );

  const visitRules = rules => {
    const ruleCount = collectionLength(rules);
    for (let index = 0; index < ruleCount; index += 1) {
      const rule = collectionItem(rules, index);
      visitedRules += 1;
      const exhausted = checkBudget();
      if (exhausted) return exhausted;

      if (typeof rule.conditionText === 'string' && rule.media) {
        const conditionText = rule.conditionText;
        const authored = getAuthoredCondition(rule, conditionText);
        conditionChars += authored.length;
        if (conditionChars > maxConditionChars) return 'media_condition_limit';
        if (clock() >= deadline) return 'media_deadline';
        const selected = selectedCondition(authored, scheme);
        rule.media.mediaText = selected;
        rewrites += 1;
        if (clock() >= deadline) return 'media_deadline';
      }

      if (rule.cssRules) {
        const nested = visitRules(rule.cssRules);
        if (nested) return nested;
      }
    }
    return null;
  };

  let sheetCount;
  try {
    sheetCount = collectionLength(sheets);
  } catch {
    return fallback('media_rule_unwritable');
  }
  if (sheetCount > maxRules) return fallback('media_rule_limit');
  // Once the absolute controller deadline is exhausted, fail closed without
  // traversing sender rules again. This bounded owner-removal pass is the only
  // legal recovery work after expiry.
  if (failClosed && clock() >= deadline) {
    if (!failClosedRemaining(0, true)) return fallback('media_rule_unwritable');
    return ready();
  }

  for (let index = 0; index < sheetCount; index += 1) {
    let sheet;
    try {
      sheet = collectionItem(sheets, index);
      visitedSheets += 1;
      const sheetDeadline = checkSheetDeadline();
      if (sheetDeadline) {
        if (!failClosed) return fallback(sheetDeadline);
        if (!hasRemovableSenderOwner(sheet)) return fallback(sheetDeadline);
        if (!failClosedRemaining(index, true)) return fallback('media_rule_unwritable');
        return ready();
      }
      const exhausted = visitRules(sheet.cssRules);
      if (exhausted) {
        if (!failClosed) return fallback(exhausted);
        if (!hasRemovableSenderOwner(sheet)) return fallback(exhausted);
        if (!failClosedRemaining(index)) return fallback('media_rule_unwritable');
        return ready();
      }
    } catch {
      if (!failClosed) return fallback('media_rule_unwritable');
      try {
        const removal = removeSenderSheet(sheet, removedOwners);
        if (removal === 'unremovable') return fallback('media_rule_unwritable');
        if (removal === 'removed') removedSheets += 1;
        const nextSheet = collectionItem(sheets, index);
        sheetCount = collectionLength(sheets);
        if (nextSheet !== sheet) index -= 1;
      } catch {
        return fallback('media_rule_unwritable');
      }
    }
  }

  if (clock() >= deadline) {
    if (!failClosed) return fallback('media_deadline');
    if (!failClosedRemaining(0, true)) return fallback('media_rule_unwritable');
  }
  return ready();
}
