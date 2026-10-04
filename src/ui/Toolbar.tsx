import { useSyncExternalStore } from 'react';
import { useStore } from '../state/useEditor';
import { exportSnapshot } from '../core/snapshot';

export function Toolbar() {
  const store = useStore();
  const state = useSyncExternalStore(store.subscribe, store.getState);
  const count = Object.keys(state.history.present.bones).length;

  const doExport = () => {
    // 导出自当前统一快照：与播放画面、单帧数值检查同一 rev
    const snap = store.getSnapshot();
    const data = exportSnapshot(snap, {
      sampleRate: 24,
      rootPosition: state.rootPosition,
    });
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `skeleton-rev${snap.rev}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="toolbar">
      <h1>二维骨骼动画编辑器</h1>
      <button onClick={() => store.undo()} disabled={!store.canUndo()} title="Ctrl+Z">
        ↶ 撤销
      </button>
      <button onClick={() => store.redo()} disabled={!store.canRedo()} title="Ctrl+Y">
        ↷ 重做
      </button>
      <div className="spacer" />
      <span style={{ color: 'var(--text-dim)' }}>骨骼 {count} / 2–15</span>
      <span className="rev-badge" title="修订号：每次提交/撤销/重做/拖动中间帧都会前进">
        rev {state.history.rev}
        {state.drag ? ' · 拖动中' : ''}
      </span>
      <button className="primary" onClick={doExport}>
        导出快照 JSON
      </button>
    </div>
  );
}
