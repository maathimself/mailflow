import { describe, expect, it } from 'vitest';
import {
  addComposeAttachmentDef,
  closeComposeSessionDef,
  createComposeSessionDef,
  discardComposeSessionDef,
  getComposeSessionDef,
  handleAddComposeAttachment,
  handleCloseComposeSession,
  handleCreateComposeSession,
  handleDiscardComposeSession,
  handleGetComposeSession,
  handleListComposeSessions,
  handleMinimizeComposeSession,
  handleRemoveComposeAttachment,
  handleRestoreComposeSession,
  handleSendComposeSession,
  handleUpdateComposeSession,
  listComposeSessionsDef,
  minimizeComposeSessionDef,
  removeComposeAttachmentDef,
  restoreComposeSessionDef,
  sendComposeSessionDef,
  updateComposeSessionDef,
} from './composeSessionTools.js';
import { HANDLERS, TOOL_DEFS, TOOL_SCOPES } from './tools.js';

const VALID_SCOPES = new Set(['read', 'write', 'send', 'settings']);
const ANNOTATION_KEYS = [
  'readOnlyHint',
  'destructiveHint',
  'idempotentHint',
  'openWorldHint',
];

const COMPOSE_DEFINITIONS = [
  listComposeSessionsDef,
  getComposeSessionDef,
  createComposeSessionDef,
  updateComposeSessionDef,
  minimizeComposeSessionDef,
  restoreComposeSessionDef,
  addComposeAttachmentDef,
  removeComposeAttachmentDef,
  closeComposeSessionDef,
  discardComposeSessionDef,
  sendComposeSessionDef,
];

const COMPOSE_SCOPES = {
  list_compose_sessions: 'read',
  get_compose_session: 'read',
  create_compose_session: 'write',
  update_compose_session: 'write',
  minimize_compose_session: 'write',
  restore_compose_session: 'write',
  add_compose_attachment: 'write',
  remove_compose_attachment: 'write',
  close_compose_session: 'write',
  discard_compose_session: 'write',
  send_compose_session: 'send',
};

const COMPOSE_HANDLERS = {
  list_compose_sessions: handleListComposeSessions,
  get_compose_session: handleGetComposeSession,
  create_compose_session: handleCreateComposeSession,
  update_compose_session: handleUpdateComposeSession,
  minimize_compose_session: handleMinimizeComposeSession,
  restore_compose_session: handleRestoreComposeSession,
  add_compose_attachment: handleAddComposeAttachment,
  remove_compose_attachment: handleRemoveComposeAttachment,
  close_compose_session: handleCloseComposeSession,
  discard_compose_session: handleDiscardComposeSession,
  send_compose_session: handleSendComposeSession,
};

describe('MCP tool registry invariants', () => {
  it('appends every compose-session definition exactly once in the approved order', () => {
    const names = TOOL_DEFS.map(({ name }) => name);
    const composeNames = COMPOSE_DEFINITIONS.map(({ name }) => name);

    expect(names.slice(-composeNames.length)).toEqual(composeNames);
    for (const definition of COMPOSE_DEFINITIONS) {
      expect(TOOL_DEFS.filter(item => item === definition), definition.name).toHaveLength(1);
      expect(names.filter(name => name === definition.name), definition.name).toHaveLength(1);
    }
  });

  it('uses the exact approved compose-session scope map', () => {
    expect(Object.fromEntries(
      Object.keys(COMPOSE_SCOPES).map(name => [name, TOOL_SCOPES[name]]),
    )).toEqual(COMPOSE_SCOPES);
  });

  it('wires every compose-session name directly to its approved handler', () => {
    for (const [name, handler] of Object.entries(COMPOSE_HANDLERS)) {
      expect(HANDLERS[name], name).toBe(handler);
    }
  });

  it('gives every tool definition all four boolean annotation hints', () => {
    for (const definition of TOOL_DEFS) {
      expect(definition.annotations, definition.name).toBeTypeOf('object');
      for (const key of ANNOTATION_KEYS) {
        expect(definition.annotations, `${definition.name}.${key}`).toHaveProperty(key);
        expect(typeof definition.annotations[key], `${definition.name}.${key}`).toBe('boolean');
      }
    }
  });

  it('classifies every definition with one or more valid scopes', () => {
    for (const definition of TOOL_DEFS) {
      const required = TOOL_SCOPES[definition.name];
      if (Array.isArray(required)) {
        expect(required.length, definition.name).toBeGreaterThanOrEqual(1);
        for (const scope of required) {
          expect(VALID_SCOPES.has(scope), `${definition.name}: ${scope}`).toBe(true);
        }
      } else {
        expect(VALID_SCOPES.has(required), `${definition.name}: ${required}`).toBe(true);
      }
    }
  });

  it('keeps definitions, scope classifications, and handlers in exact three-way sync', () => {
    const definitions = TOOL_DEFS.map(({ name }) => name).sort();
    expect(Object.keys(TOOL_SCOPES).sort()).toEqual(definitions);
    expect(Object.keys(HANDLERS).sort()).toEqual(definitions);
  });
});
