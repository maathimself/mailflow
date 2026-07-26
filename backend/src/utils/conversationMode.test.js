import { describe, expect, it } from 'vitest';
import { sanitizeConversationMode } from './conversationMode.js';

describe('sanitizeConversationMode', () => {
  it.each(['off', 'list', 'pane'])('accepts %s', mode => {
    expect(sanitizeConversationMode(mode)).toBe(mode);
  });

  it('rejects other values', () => {
    expect(sanitizeConversationMode('threaded')).toBeNull();
  });
});
