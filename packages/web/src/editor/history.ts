/**
 * Undo/redo as a pure past/present/future reducer.
 *
 * The plan calls for replay-based undo rather than inverting CSG operations,
 * and this is the state half of that: history stores whole `EditState`
 * snapshots (a transform plus an ordered list of cuts), which are tiny — a
 * handful of numbers each. Geometry is never stored here; `csg.replayOperations`
 * regenerates it from the raw extraction whenever the operation list changes.
 *
 * Everything is immutable so React and zustand see new object identities.
 */

export interface HistoryState<T> {
  past: T[];
  present: T;
  future: T[];
  /**
   * Identifier of the interaction that produced `present`. Consecutive commits
   * sharing a key collapse into one undo step, so dragging a gizmo — which
   * fires a change per frame — costs one entry, not two hundred.
   */
  coalesceKey: string | null;
}

/** Cap on undo depth. Snapshots are small, but a session should not grow without bound. */
export const DEFAULT_HISTORY_LIMIT = 100;

export function createHistory<T>(present: T): HistoryState<T> {
  return { past: [], present, future: [], coalesceKey: null };
}

export interface CommitOptions {
  /**
   * Group this change with the immediately preceding one when the keys match.
   * Use a value that is stable for one gesture and unique across gestures,
   * e.g. `scale:${dragId}`.
   */
  coalesceKey?: string;
  limit?: number;
}

/**
 * Record a new state. Any redo stack is discarded, which is the standard
 * linear-history behaviour users expect from an editor.
 */
export function commit<T>(
  history: HistoryState<T>,
  next: T,
  options: CommitOptions = {},
): HistoryState<T> {
  const { coalesceKey, limit = DEFAULT_HISTORY_LIMIT } = options;

  // Replace the present in place when continuing the same gesture, so the
  // undo step jumps back to before the drag began.
  if (coalesceKey !== undefined && coalesceKey === history.coalesceKey) {
    return { ...history, present: next, future: [] };
  }

  const past = [...history.past, history.present];
  return {
    past: past.length > limit ? past.slice(past.length - limit) : past,
    present: next,
    future: [],
    coalesceKey: coalesceKey ?? null,
  };
}

export function canUndo<T>(history: HistoryState<T>): boolean {
  return history.past.length > 0;
}

export function canRedo<T>(history: HistoryState<T>): boolean {
  return history.future.length > 0;
}

export function undo<T>(history: HistoryState<T>): HistoryState<T> {
  if (!canUndo(history)) return history;
  const previous = history.past[history.past.length - 1]!;
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future],
    // Clear the gesture key so a fresh edit after undo always starts a new step.
    coalesceKey: null,
  };
}

export function redo<T>(history: HistoryState<T>): HistoryState<T> {
  if (!canRedo(history)) return history;
  const next = history.future[0]!;
  return {
    past: [...history.past, history.present],
    present: next,
    future: history.future.slice(1),
    coalesceKey: null,
  };
}

/** Discard all history, keeping the current state — used when loading a new model. */
export function resetHistory<T>(history: HistoryState<T>, present?: T): HistoryState<T> {
  return createHistory(present === undefined ? history.present : present);
}
