const keys = (primary = null, secondary = []) => Object.freeze({
  primary,
  secondary: Object.freeze(secondary),
});
const modKey = (mac, key) => Object.freeze({
  mac,
  windows: `ctrl+${key}`,
  linux: `ctrl+${key}`,
  default: `ctrl+${key}`,
});

const lifecycleAvailable = context => {
  const sessionId = context.draft?.id;
  const sessions = context.composeSlots || [];
  if (!sessionId) return false;
  const session = sessions.find(item => item.id === sessionId);
  return Boolean(session) && !session.terminalPending;
};

const occupiedSlot = (context, slot) => (context.composeSlots || [])
  .some(session => session.slot === slot && !session.terminalPending);

function definition({
  id,
  titleKey,
  icon = 'compose',
  defaultKeys = keys(),
  rank = 80,
  isAvailable,
  executorId,
  params = {},
  aliasKeys = [],
  targetMode = 'global',
}) {
  return Object.freeze({
    id,
    titleKey,
    aliasKeys: Object.freeze(aliasKeys),
    icon,
    group: 'compose',
    defaultKeys,
    rank: Object.freeze({ base: rank }),
    isAvailable,
    targetMode,
    executorId,
    params: Object.freeze(params),
  });
}

const lifecycle = (id, titleKey, executorId, rank, defaultKeys) => definition({
  id,
  titleKey,
  executorId,
  rank,
  isAvailable: lifecycleAvailable,
  targetMode: 'draft',
  ...(defaultKeys ? { defaultKeys } : {}),
});

const slotDefinitions = Array.from({ length: 9 }, (_, index) => {
  const slot = index + 1;
  return definition({
    id: `compose.activateSlot${slot}`,
    titleKey: 'commands.compose.activateSlot',
    executorId: 'compose.activateSlot',
    params: { slot },
    rank: 70 - slot,
    isAvailable: context => occupiedSlot(context, slot),
  });
});

export const composeSessionCommandDefinitions = Object.freeze([
  definition({
    id: 'compose.new',
    titleKey: 'commands.compose.new.title',
    executorId: 'compose.create',
    defaultKeys: keys('c'),
    aliasKeys: ['commands.compose.new.alias.write'],
    rank: 100,
    isAvailable: context => !['settings', 'picker'].includes(context.surface)
      && new Set((context.composeSlots || []).map(session => session.slot)).size < 9,
  }),
  lifecycle('compose.minimize', 'commands.compose.minimize', 'compose.minimize', 85),
  lifecycle('compose.close', 'commands.compose.close', 'compose.close', 84),
  lifecycle('compose.discard', 'commands.compose.discard', 'compose.discard', 50),
  lifecycle('compose.send', 'compose.send', 'compose.send', 90, keys(modKey('meta+enter', 'enter'))),
  ...slotDefinitions,
]);

const success = value => ({ status: 'success', value });

function requestedSession(context, input, fallback = 'recent') {
  const sessionId = input?.sessionId || context?.draft?.id;
  const sessions = context?.composeSlots || [];
  if (sessionId && sessions.some(session => session.id === sessionId)) return sessionId;
  const visible = sessions.filter(session => session.visible !== false
    && session.presentationState !== 'minimized');
  if (fallback === 'leftmost') {
    return [...visible].sort((left, right) => Date.parse(left.createdAt || 0) - Date.parse(right.createdAt || 0)
      || left.slot - right.slot)[0]?.id || null;
  }
  return [...visible].sort((left, right) => Date.parse(right.lastFocusedAt || 0) - Date.parse(left.lastFocusedAt || 0)
    || right.slot - left.slot)[0]?.id || null;
}

export function createComposeSessionCommandExecutors({ getController, openCompose }) {
  const controller = () => getController?.() || null;
  const runSession = (method, fallback) => async ({ context, input } = {}) => {
    const workspace = controller();
    const sessionId = requestedSession(context, input, fallback);
    if (!workspace?.[method] || !sessionId) return { status: 'cancelled' };
    const value = await workspace[method](sessionId);
    return success(value);
  };

  return Object.freeze({
    'compose.create': async ({ context, input } = {}) => {
      const changes = input || (context?.accountId ? { accountId: context.accountId } : {});
      if (openCompose) return success(await openCompose(changes));
      const workspace = controller();
      if (!workspace?.createSession) return { status: 'cancelled' };
      return success(await workspace.createSession(changes));
    },
    'compose.minimize': runSession('minimizeSession', 'leftmost'),
    'compose.close': runSession('closeSession'),
    'compose.discard': runSession('discardSession'),
    'compose.send': async ({ context, input } = {}) => {
      const workspace = controller();
      const sessionId = requestedSession(context, input);
      if (!workspace?.sendSession || !sessionId) return { status: 'cancelled' };
      const options = { ...(input || {}) };
      delete options.sessionId;
      return success(await workspace.sendSession(sessionId, options));
    },
    'compose.activateSlot': async ({ command, context } = {}) => {
      const workspace = controller();
      const session = (context?.composeSlots || [])
        .find(item => item.slot === command?.params?.slot && !item.terminalPending);
      if (!workspace?.focusSession || !session) return { status: 'cancelled' };
      return success(await workspace.focusSession(session.id));
    },
  });
}
