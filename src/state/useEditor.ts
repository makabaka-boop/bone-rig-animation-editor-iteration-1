import { createEditorStore, type EditorStore } from '../core/store';
import { useSyncExternalStore } from 'react';

/**
 * 模块级单例 store。整个应用（画布、树、检查器、时间轴、导出）
 * 都订阅同一个 store，共享同一条修订历史。
 */
let storeSingleton: EditorStore | null = null;

export function getStore(): EditorStore {
  if (!storeSingleton) storeSingleton = createEditorStore();
  return storeSingleton;
}

export function useStore(): EditorStore {
  return getStore();
}

/** 订阅编辑器状态（任何变更都触发重渲染，由 React 做粒度裁剪） */
export function useEditorState() {
  const store = getStore();
  return useSyncExternalStore(store.subscribe, store.getState);
}
