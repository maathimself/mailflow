import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  capacityForDockWidth,
  visibleComposeSessions,
  composeChipSessions,
  nextComposeFocus,
} from './workspaceState.js';

const sessions = [
  { id: 'a', slot: 1, presentationState: 'expanded', createdAt: '2026-01-01', lastFocusedAt: '2026-01-01' },
  { id: 'b', slot: 2, presentationState: 'expanded', createdAt: '2026-01-02', lastFocusedAt: '2026-01-03' },
  { id: 'c', slot: 3, presentationState: 'minimized', createdAt: '2026-01-03', lastFocusedAt: '2026-01-02' },
];

describe('compose workspace layout', () => {
  it('derives 3/2/1 capacity from usable content width and clamps its range', () => {
    assert.equal(capacityForDockWidth(1220), 3);
    assert.equal(capacityForDockWidth(940), 2);
    assert.equal(capacityForDockWidth(720), 1);
    assert.equal(capacityForDockWidth(771), 1);
    assert.equal(capacityForDockWidth(772), 2);
    assert.equal(capacityForDockWidth(1163), 2);
    assert.equal(capacityForDockWidth(1164), 3);
    assert.equal(capacityForDockWidth(10_000), 3);
    assert.equal(capacityForDockWidth(0), 1);
  });

  it('defaults invalid widths to the minimum capacity', () => {
    for (const width of [-1, NaN, Infinity, -Infinity, '772', null, undefined, {}, []]) {
      assert.equal(capacityForDockWidth(width), 1);
    }
  });

  it('keeps most recently focused expanded sessions visible in creation order', () => {
    assert.deepEqual(visibleComposeSessions(sessions, 1).map(x => x.id), ['b']);
    assert.deepEqual(visibleComposeSessions(sessions, 2).map(x => x.id), ['a', 'b']);

    const newestFirst = [
      { id: 'new', slot: 4, presentationState: 'expanded', createdAt: '2026-01-04', lastFocusedAt: '2026-01-06' },
      { id: 'old', slot: 5, presentationState: 'expanded', createdAt: '2026-01-01', lastFocusedAt: '2026-01-05' },
    ];
    assert.deepEqual(visibleComposeSessions(newestFirst, 2).map(x => x.id), ['old', 'new']);
  });

  it('combines explicit minimize and local overflow as slot-ordered chips', () => {
    assert.deepEqual(composeChipSessions(sessions, 1).map(x => x.slot), [1, 3]);
  });

  it('breaks equal focus and creation timestamps by slot for selection and rendering', () => {
    const tied = [
      { id: 'slot-3', slot: 3, presentationState: 'expanded', createdAt: '2026-01-01', lastFocusedAt: '2026-01-02' },
      { id: 'slot-2', slot: 2, presentationState: 'expanded', createdAt: '2026-01-01', lastFocusedAt: '2026-01-02' },
      { id: 'slot-1', slot: 1, presentationState: 'expanded', createdAt: '2026-01-01', lastFocusedAt: '2026-01-02' },
    ];

    assert.deepEqual(visibleComposeSessions(tied, 2).map(session => session.id), ['slot-1', 'slot-2']);
    assert.deepEqual(composeChipSessions(tied, 2).map(session => session.id), ['slot-3']);
    assert.equal(nextComposeFocus(tied), 'slot-1');
  });

  it('selects a deterministic focus fallback after removal or minimize', () => {
    const remainingAfterRemoval = sessions.filter(session => session.id !== 'b');
    assert.equal(nextComposeFocus(remainingAfterRemoval), 'a');

    const afterMinimize = sessions.map(session => session.id === 'b'
      ? { ...session, presentationState: 'minimized' }
      : session);
    assert.equal(nextComposeFocus(afterMinimize), 'a');
    assert.equal(nextComposeFocus(afterMinimize.filter(session => session.id !== 'a')), null);
  });

  it('does not mutate input order or session objects', () => {
    const input = sessions.map(session => Object.freeze({ ...session }));
    const originalOrder = [...input];
    const originalValues = structuredClone(input);

    const visible = visibleComposeSessions(input, 1);
    const chips = composeChipSessions(input, 1);
    nextComposeFocus(input);

    assert.deepEqual(input, originalValues);
    assert.deepEqual(input, originalOrder);
    input.forEach((session, index) => assert.equal(session, originalOrder[index]));
    assert.equal(visible[0], input[1]);
    assert.equal(chips[0], input[0]);
  });
});
