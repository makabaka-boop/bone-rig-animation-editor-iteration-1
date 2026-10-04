/**
 * 通用不可变历史栈。结构编辑与姿态编辑都走同一个 commit，
 * 因此统一进入可撤销历史，回放后仍可撤销回编辑前状态。
 */
export interface History<T> {
  past: T[];
  present: T;
  future: T[];
  /** 单调递增的修订号：commit / undo / redo 都会 +1 */
  rev: number;
}

const HISTORY_LIMIT = 200;

export function initHistory<T>(present: T, rev = 1): History<T> {
  return { past: [], present, future: [], rev };
}

export function commit<T>(h: History<T>, next: T): History<T> {
  if (next === h.present) return h;
  const past = [...h.past, h.present];
  if (past.length > HISTORY_LIMIT) past.shift();
  return { past, present: next, future: [], rev: h.rev + 1 };
}

export function undo<T>(h: History<T>): History<T> {
  if (h.past.length === 0) return h;
  const previous = h.past[h.past.length - 1];
  return {
    past: h.past.slice(0, -1),
    present: previous,
    future: [h.present, ...h.future],
    rev: h.rev + 1,
  };
}

export function redo<T>(h: History<T>): History<T> {
  if (h.future.length === 0) return h;
  const [next, ...rest] = h.future;
  return {
    past: [...h.past, h.present],
    present: next,
    future: rest,
    rev: h.rev + 1,
  };
}

/** 仅推进修订号（拖动中间帧），不产生撤销条目 */
export function touch<T>(h: History<T>, present: T): History<T> {
  return { ...h, present, rev: h.rev + 1 };
}

export const canUndo = <T,>(h: History<T>): boolean => h.past.length > 0;
export const canRedo = <T,>(h: History<T>): boolean => h.future.length > 0;
