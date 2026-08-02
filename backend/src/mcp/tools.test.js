import { describe, expect, it } from 'vitest';
import { HANDLERS, TOOL_DEFS, TOOL_SCOPES } from './tools.js';

const VALID_SCOPES = new Set(['read', 'write', 'send', 'settings']);
const ANNOTATION_KEYS = [
  'readOnlyHint',
  'destructiveHint',
  'idempotentHint',
  'openWorldHint',
];

describe('MCP tool registry invariants', () => {
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
