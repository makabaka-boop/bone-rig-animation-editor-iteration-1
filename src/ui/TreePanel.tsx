import { useSyncExternalStore } from 'react';
import { useStore } from '../state/useEditor';
import { childMap, depthOf, orderedBoneIds, MAX_BONES } from '../core/skeleton';
import type { Bone } from '../core/types';

function useStoreState() {
  const store = useStore();
  return useSyncExternalStore(store.subscribe, store.getState);
}


export function TreePanel() {
  const store = useStore();
  const state = useStoreState();
  const doc = state.history.present;
  const order = orderedBoneIds(doc);
  const children = childMap(doc.bones);
  const count = Object.keys(doc.bones).length;

  const renderRow = (bone: Bone) => {
    const depth = depthOf(doc.bones, bone.id);
    const selected = state.selection === bone.id;
    return (
      <div key={bone.id}>
        <div
          className={`tree-row ${selected ? 'selected' : ''}`}
          onClick={() => store.select(bone.id)}
        >
          <span className="depth">{' '.repeat(depth)}{depth > 0 ? '└' : '●'}</span>
          <span className="name">{bone.name}</span>
          {bone.parentId === null && <span title="根骨骼">根</span>}
        </div>
        {(children.get(bone.id) ?? []).map((id) => renderRow(doc.bones[id]))}
      </div>
    );
  };

  return (
    <div className="panel tree">
      <h2>骨骼树（{count}/{MAX_BONES}）</h2>
      <div style={{ padding: '0 10px 8px', display: 'flex', gap: 6 }}>
        <button
          className="primary"
          style={{ flex: 1 }}
          disabled={count >= MAX_BONES}
          onClick={() => {
            const parentId = state.selection ?? doc.rootId;
            const id = store.addChildBone(parentId);
            if (id) store.select(id);
          }}
        >
          + 子骨骼
        </button>
        <button
          style={{ display: doc.rootId ? 'none' : undefined }}
          disabled={!!doc.rootId || count >= MAX_BONES}
          title="创建根骨骼"
          onClick={() => {
            const id = store.addChildBone(null);
            if (id) store.select(id);
          }}
        >
          +根
        </button>
      </div>
      {order.map((id) => renderRow(doc.bones[id]))}
      {order.length === 0 && (
        <div style={{ padding: 14, color: 'var(--text-dim)' }}>
          空骨架，点「+根」开始
        </div>
      )}
    </div>
  );
}
