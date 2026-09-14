import { describe, expect, it } from 'vitest';
import { detectAttachments } from './messageParser.js';

describe('detectAttachments', () => {
  it('flags an explicit attachment disposition anywhere in the tree', () => {
    expect(detectAttachments({
      type: 'multipart/mixed',
      childNodes: [
        { type: 'text/plain' },
        { type: 'application/pdf', disposition: 'attachment', dispositionParameters: { filename: 'a.pdf' } },
      ],
    })).toBe(true);
  });

  it('flags a named inline text part alongside an unnamed body part', () => {
    expect(detectAttachments({
      type: 'multipart/mixed',
      childNodes: [
        { type: 'text/html' },
        { type: 'text/html', disposition: 'inline', dispositionParameters: { filename: 'report.html' } },
      ],
    })).toBe(true);
    expect(detectAttachments({
      type: 'multipart/mixed',
      childNodes: [
        { type: 'text/plain' },
        { type: 'text/plain', parameters: { name: 'server.log' } },
      ],
    })).toBe(true);
  });

  it('does not flag an ordinary multipart/alternative body', () => {
    expect(detectAttachments({
      type: 'multipart/alternative',
      childNodes: [{ type: 'text/plain' }, { type: 'text/html' }],
    })).toBe(false);
  });

  it('does not flag a message whose only text parts are named', () => {
    expect(detectAttachments({
      type: 'multipart/alternative',
      childNodes: [
        { type: 'text/plain', parameters: { name: 'body.txt' } },
        { type: 'text/html', parameters: { name: 'body.html' } },
      ],
    })).toBe(false);
  });

  it('is false for missing structure', () => {
    expect(detectAttachments(null)).toBe(false);
  });
});
