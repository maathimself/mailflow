export const TARGET_MODES = Object.freeze({
  GLOBAL: 'global',
  ACCOUNT: 'account',
  DRAFT: 'draft',
  SINGLE_CONVERSATION: 'single_conversation',
  BULK_SAFE: 'bulk_safe',
});

export const SURFACES = Object.freeze(['list', 'conversation', 'compose', 'settings', 'picker']);
export const PLATFORMS = Object.freeze(['mac', 'windows', 'linux']);

/** @typedef {string | {default?: string, mac?: string, windows?: string, linux?: string}} KeySpec */

/**
 * @typedef {object} CommandDefinition
 * @property {string} id
 * @property {string} titleKey
 * @property {string[]} aliasKeys
 * @property {string} icon
 * @property {string} group
 * @property {{primary: KeySpec | null, secondary: KeySpec[]}} defaultKeys
 * @property {{base: number, boost?: (context: CommandContext) => number}} rank
 * @property {(context: CommandContext) => boolean} isAvailable
 * @property {'global'|'account'|'draft'|'single_conversation'|'bulk_safe'} targetMode
 * @property {string} executorId
 * @property {Readonly<Record<string, unknown>>} [params]
 */

/**
 * @typedef {object} CommandContext
 * @property {'list'|'conversation'|'compose'|'settings'|'picker'} surface
 * @property {string | null} activeConversationId
 * @property {object | null} activeMessage
 * @property {readonly string[]} selectedConversationIds
 * @property {readonly string[]} visibleConversationIds
 * @property {Readonly<Record<string, {id: string, rowId: string, accountId: string | null, message: object}>>} conversationsById
 * @property {string | null} accountId
 * @property {string | null} folder
 * @property {object | null} draft
 * @property {boolean} gtdAvailable
 * @property {boolean} cardDavConnected
 * @property {object | null} modal
 * @property {boolean} editing
 * @property {boolean} undoAvailable
 * @property {'mac'|'windows'|'linux'} platform
 * @property {Readonly<Record<string, string | null>>} shortcutOverrides
 * @property {(key: string, values?: object) => string} translate
 */

function freezeKeySpec(spec) {
  return spec && typeof spec === 'object' ? Object.freeze({ ...spec }) : spec;
}

export function stableConversationId(message) {
  const accountId = message?.account_id;
  const withinAccountId = message?.message_id || message?.id;
  return accountId && withinAccountId ? `${accountId}:${withinAccountId}` : null;
}

export function validateCommandDefinition(input) {
  if (!input?.id?.includes('.')) throw new TypeError('command id must be namespaced');
  for (const key of ['titleKey', 'icon', 'group']) {
    if (typeof input[key] !== 'string' || !input[key]) throw new TypeError(`${key} must be a non-empty string`);
  }
  if (!Array.isArray(input.aliasKeys) || input.aliasKeys.some(key => typeof key !== 'string')) {
    throw new TypeError('aliasKeys must be an array of localization keys');
  }
  if (!Object.values(TARGET_MODES).includes(input.targetMode)) {
    throw new TypeError(`unsupported targetMode "${input.targetMode}"`);
  }
  if (typeof input.executorId !== 'string' || !input.executorId) {
    throw new TypeError('executorId must be a non-empty string');
  }
  if (typeof input.isAvailable !== 'function') throw new TypeError('isAvailable must be a function');
  if (!Number.isFinite(input.rank?.base)) throw new TypeError('rank.base must be a finite number');
  if (input.rank.boost != null && typeof input.rank.boost !== 'function') {
    throw new TypeError('rank.boost must be a function');
  }
  const primary = freezeKeySpec(input.defaultKeys?.primary ?? null);
  const secondary = Object.freeze((input.defaultKeys?.secondary || []).map(freezeKeySpec));
  return Object.freeze({
    ...input,
    aliasKeys: Object.freeze([...input.aliasKeys]),
    defaultKeys: Object.freeze({ primary, secondary }),
    rank: Object.freeze({ ...input.rank }),
    params: Object.freeze({ ...(input.params || {}) }),
  });
}

export function createCommandContext(input) {
  if (!SURFACES.includes(input.surface)) throw new TypeError(`unsupported surface "${input.surface}"`);
  if (!PLATFORMS.includes(input.platform)) throw new TypeError(`unsupported platform "${input.platform}"`);
  if (typeof input.translate !== 'function') throw new TypeError('translate must be a function');

  const conversationsById = {};
  for (const message of input.conversations || []) {
    const id = stableConversationId(message);
    if (!id || conversationsById[id]) continue;
    conversationsById[id] = Object.freeze({
      id,
      rowId: message.id,
      accountId: message.account_id ?? null,
      message,
    });
  }
  const selectedConversationIds = [...new Set(input.selectedConversationIds || [])];
  return Object.freeze({
    surface: input.surface,
    activeConversationId: input.activeConversationId || null,
    activeMessage: input.activeMessage || null,
    selectedConversationIds: Object.freeze(selectedConversationIds),
    visibleConversationIds: Object.freeze([...new Set(input.visibleConversationIds || [])]),
    conversationsById: Object.freeze(conversationsById),
    accountId: input.accountId || null,
    folder: input.folder || null,
    draft: input.draft || null,
    gtdAvailable: Boolean(input.gtdAvailable),
    cardDavConnected: Boolean(input.cardDavConnected),
    modal: input.modal || null,
    editing: Boolean(input.editing),
    undoAvailable: Boolean(input.undoAvailable),
    platform: input.platform,
    shortcutOverrides: Object.freeze({ ...(input.shortcutOverrides || {}) }),
    translate: input.translate,
  });
}
