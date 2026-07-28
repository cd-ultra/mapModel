import { describe, expect, it } from 'vitest';
import {
  canRedo,
  canUndo,
  commit,
  createHistory,
  redo,
  resetHistory,
  undo,
} from './history.js';

describe('history', () => {
  it('starts empty', () => {
    const h = createHistory('a');
    expect(h.present).toBe('a');
    expect(canUndo(h)).toBe(false);
    expect(canRedo(h)).toBe(false);
  });

  it('walks backwards and forwards through commits', () => {
    let h = createHistory('a');
    h = commit(h, 'b');
    h = commit(h, 'c');
    expect(h.present).toBe('c');

    h = undo(h);
    expect(h.present).toBe('b');
    h = undo(h);
    expect(h.present).toBe('a');
    expect(canUndo(h)).toBe(false);

    h = redo(h);
    expect(h.present).toBe('b');
    h = redo(h);
    expect(h.present).toBe('c');
    expect(canRedo(h)).toBe(false);
  });

  it('is a no-op at the ends rather than throwing', () => {
    const h = createHistory('a');
    expect(undo(h)).toBe(h);
    expect(redo(h)).toBe(h);
  });

  it('discards the redo stack on a new commit', () => {
    let h = createHistory('a');
    h = commit(h, 'b');
    h = undo(h);
    expect(canRedo(h)).toBe(true);

    h = commit(h, 'c');
    expect(canRedo(h)).toBe(false);
    expect(h.present).toBe('c');
  });

  it('collapses one gesture into a single undo step', () => {
    let h = createHistory(0);
    // A scale drag emitting a value per frame.
    for (let i = 1; i <= 50; i += 1) {
      h = commit(h, i, { coalesceKey: 'scale:drag-1' });
    }
    expect(h.present).toBe(50);
    expect(h.past).toHaveLength(1);

    h = undo(h);
    expect(h.present).toBe(0);
  });

  it('separates distinct gestures', () => {
    let h = createHistory(0);
    h = commit(h, 1, { coalesceKey: 'scale:drag-1' });
    h = commit(h, 2, { coalesceKey: 'scale:drag-1' });
    h = commit(h, 3, { coalesceKey: 'scale:drag-2' });

    expect(h.past).toHaveLength(2);
    h = undo(h);
    expect(h.present).toBe(2);
    h = undo(h);
    expect(h.present).toBe(0);
  });

  it('starts a new step after an undo even with a repeated key', () => {
    let h = createHistory(0);
    h = commit(h, 1, { coalesceKey: 'k' });
    h = undo(h);
    h = commit(h, 2, { coalesceKey: 'k' });
    expect(h.past).toHaveLength(1);
    expect(undo(h).present).toBe(0);
  });

  it('does not coalesce un-keyed commits with each other', () => {
    let h = createHistory(0);
    h = commit(h, 1);
    h = commit(h, 2);
    expect(h.past).toHaveLength(2);
  });

  it('bounds memory by dropping the oldest entries past the limit', () => {
    let h = createHistory(0);
    for (let i = 1; i <= 10; i += 1) h = commit(h, i, { limit: 4 });

    expect(h.past).toHaveLength(4);
    expect(h.present).toBe(10);
    // The oldest reachable state is 6, not 0.
    expect(h.past[0]).toBe(6);
  });

  it('never mutates the state it was given', () => {
    const h = createHistory('a');
    const committed = commit(h, 'b');
    expect(h.past).toHaveLength(0);
    expect(h.present).toBe('a');
    expect(committed).not.toBe(h);
  });

  it('resets to a fresh state when a new model is loaded', () => {
    let h = createHistory('a');
    h = commit(h, 'b');
    const fresh = resetHistory(h, 'z');

    expect(fresh.present).toBe('z');
    expect(canUndo(fresh)).toBe(false);
    expect(canRedo(fresh)).toBe(false);
  });
});
