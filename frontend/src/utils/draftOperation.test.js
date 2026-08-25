import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as composeOperations from './draftOperation.js';

const { selectDraftOperation } = composeOperations;

describe('selectDraftOperation', () => {
  it('reuses the key for an unchanged retry and rotates it after the payload changes', () => {
    let sequence = 0;
    const createKey = () => `key-${++sequence}`;
    const first = selectDraftOperation(null, { subject: 'first', body: 'body' }, createKey);
    const unchanged = selectDraftOperation(first, { subject: 'first', body: 'body' }, createKey);
    const edited = selectDraftOperation(unchanged, { subject: 'edited', body: 'body' }, createKey);

    assert.equal(unchanged.key, first.key);
    assert.notEqual(edited.key, unchanged.key);
  });
});

describe('selectSendOperation', () => {
  it('rotates on edits only after a conclusively pre-provider failure', () => {
    assert.equal(typeof composeOperations.selectSendOperation, 'function');
    assert.equal(typeof composeOperations.recordSendFailure, 'function');
    const { selectSendOperation, recordSendFailure } = composeOperations;
    let sequence = 0;
    const createKey = () => `key-${++sequence}`;
    const originalPayload = { subject: 'first', body: 'body' };
    const editedPayload = { subject: 'edited', body: 'body' };

    const first = selectSendOperation(null, originalPayload, createKey);
    const safeFailure = recordSendFailure(first, {
      operationKeyDisposition: 'rotate_on_payload_change',
    });
    const unchangedRetry = selectSendOperation(safeFailure, originalPayload, createKey);
    const editedRetry = selectSendOperation(safeFailure, editedPayload, createKey);

    assert.equal(unchangedRetry.key, first.key);
    assert.notEqual(editedRetry.key, first.key);

    const ambiguousFailure = recordSendFailure(first, {
      operationKeyDisposition: 'retain',
    });
    const ambiguousEditedRetry = selectSendOperation(
      ambiguousFailure, editedPayload, createKey,
    );
    assert.equal(ambiguousEditedRetry.key, first.key);
  });
});
