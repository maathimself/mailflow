import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/mailAccess.js', () => ({
  getAnnotatedThreadKeysMissingFolder: vi.fn(),
  getMessageAnnotations: vi.fn(),
  getThreadAnnotationRows: vi.fn(),
  setMessageAnnotation: vi.fn(),
  setThreadAnnotation: vi.fn(),
}));

import * as mailAccess from '../services/mailAccess.js';
import {
  getAnnotatedThreadKeysMissingFolder,
  getMessageAnnotations,
  setMessageAnnotation,
  setThreadAnnotation,
} from './gtdApi.js';

beforeEach(() => vi.clearAllMocks());

describe('bundled GTD annotation capabilities', () => {
  it('binds message annotation reads and writes to the GTD namespace', async () => {
    await getMessageAnnotations('account-1', ['message-1']);
    await setMessageAnnotation('account-1', 'message-1', { gist: 'Follow up' });

    expect(mailAccess.getMessageAnnotations).toHaveBeenCalledWith(
      'account-1', ['message-1'], 'gtd',
    );
    expect(mailAccess.setMessageAnnotation).toHaveBeenCalledWith(
      'account-1', 'message-1', 'gtd', { gist: 'Follow up' },
    );
  });

  it('binds thread annotation queries and writes to the GTD namespace', async () => {
    await getAnnotatedThreadKeysMissingFolder('account-1', 'Delegated', 'delegation');
    await setThreadAnnotation('account-1', 'thread-1', 'delegation', { contactId: 'contact-1' });

    expect(mailAccess.getAnnotatedThreadKeysMissingFolder).toHaveBeenCalledWith(
      'account-1', 'Delegated', 'gtd', 'delegation',
    );
    expect(mailAccess.setThreadAnnotation).toHaveBeenCalledWith(
      'account-1', 'thread-1', 'gtd', 'delegation', { contactId: 'contact-1' },
    );
  });
});
