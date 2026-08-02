import { describe, it, expect } from 'vitest';
import { jsonResult, errorResult } from './result.js';
import { HANDLERS, TOOL_DEFS } from './tools.js';

describe('result helpers', () => {
  it('jsonResult wraps a JSON string in a text content block', () => {
    expect(jsonResult({ ok: true })).toEqual({
      content: [{ type: 'text', text: '{"ok":true}' }],
    });
  });
  it('errorResult marks isError and carries the message verbatim', () => {
    expect(errorResult('boom')).toEqual({
      content: [{ type: 'text', text: 'boom' }],
      isError: true,
    });
  });
});

describe('ping tool', () => {
  it('is registered with a JSON-schema input', () => {
    const def = TOOL_DEFS.find((t) => t.name === 'ping');
    expect(def).toBeTruthy();
    expect(def.inputSchema).toEqual({ type: 'object', properties: {} });
  });
  it('echoes pong and is scope-agnostic', async () => {
    const r = await HANDLERS.ping({}, { userId: 'u', accountIds: [] });
    expect(r.content[0].text).toBe('{"pong":true}');
  });
});
