import { useSyncExternalStore } from 'react';
import { useStore } from '../state/useEditor';
import { evaluatePose, findWorldBone, orderedBoneIds, sampleTrack } from '../core/skeleton';
import { depthOf } from '../core/skeleton';
import type { Bone } from '../core/types';

const RAD = 180 / Math.PI;

export function Inspector() {
  const store = useStore();
  const state = useSyncExternalStore(store.subscribe, store.getState);
  const doc = state.history.present;
  const bone = state.selection ? doc.bones[state.selection] : undefined;

  // 单帧数值检查与播放、导出同源：统一取自修订快照
  const snap = store.getSnapshot();
  const pose = evaluatePose(snap.doc, state.time, {
    rootPosition: state.rootPosition,
  });

  return (
    <div className="panel inspector">
      <h2>检查器</h2>
      {!bone ? (
        <div style={{ padding: 14, color: 'var(--text-dim)' }}>未选中骨骼</div>
      ) : (
        <>
          <BoneFields bone={bone} />
          <ConstraintFields bone={bone} />
          <ParentSelect bone={bone} />
          <FrameNumbers boneId={bone.id} pose={pose} />
          <KeyframeActions bone={bone} />
          <DangerZone bone={bone} depth={depthOf(doc.bones, bone.id)} />
        </>
      )}
      <Issues />
      <div className="check-nums">
        <span>快照修订 rev={snap.rev}（播放 / 数值 / 导出共用）</span>
      </div>
    </div>
  );
}

function BoneFields({ bone }: { bone: Bone }) {
  const store = useStore();
  return (
    <div className="section">
      <h2>骨骼</h2>
      <div className="field">
        <label>名称</label>
        <input
          type="text"
          value={bone.name}
          onChange={(e) => store.updateBone(bone.id, { name: e.target.value })}
        />
      </div>
      <div className="field">
        <label>静息角度</label>
        <input
          type="range"
          min={-Math.PI}
          max={Math.PI}
          step={0.01}
          value={bone.angle}
          onChange={(e) => store.updateBone(bone.id, { angle: Number(e.target.value) })}
        />
        <span className="value">{((bone.angle * RAD) as number).toFixed(0)}°</span>
      </div>
      <div className="field">
        <label>长度</label>
        <input
          type="number"
          min={1}
          value={Math.round(bone.length)}
          onChange={(e) => store.updateBone(bone.id, { length: Number(e.target.value) })}
        />
        <span className="value">px</span>
      </div>
    </div>
  );
}

function ConstraintFields({ bone }: { bone: Bone }) {
  const store = useStore();
  return (
    <div className="section">
      <h2>关节角度限位（局部，度）</h2>
      <div className="field">
        <label>最小角</label>
        <input
          type="number"
          step={1}
          value={(bone.minAngle * RAD).toFixed(0)}
          onChange={(e) =>
            store.updateBone(bone.id, { minAngle: Number(e.target.value) / RAD })
          }
        />
        <span className="value">°</span>
      </div>
      <div className="field">
        <label>最大角</label>
        <input
          type="number"
          step={1}
          value={(bone.maxAngle * RAD).toFixed(0)}
          onChange={(e) =>
            store.updateBone(bone.id, { maxAngle: Number(e.target.value) / RAD })
          }
        />
        <span className="value">°</span>
      </div>
    </div>
  );
}

function ParentSelect({ bone }: { bone: Bone }) {
  const store = useStore();
  const state = useSyncExternalStore(store.subscribe, store.getState);
  const doc = state.history.present;
  if (bone.parentId === null) return null;

  // 可作为新父的候选：除自己及自己后代之外的所有骨骼
  const order = orderedBoneIds(doc);
  const isDescendant = (ancestorId: string, targetId: string): boolean => {
    let cur: string | null = targetId;
    while (cur) {
      if (cur === ancestorId) return true;
      cur = doc.bones[cur]?.parentId ?? null;
    }
    return false;
  };

  return (
    <div className="section">
      <h2>父子关系</h2>
      <div className="field">
        <label>父骨骼</label>
        <select
          value={bone.parentId ?? ''}
          onChange={(e) => {
            const ok = store.reparent(bone.id, e.target.value || null);
            if (!ok) alert('无法挂到该骨骼：会形成环');
          }}
        >
          {order
            .filter((id) => id !== bone.id && !isDescendant(bone.id, id))
            .map((id) => (
              <option key={id} value={id}>
                {' '.repeat(depthOf(doc.bones, id) * 2)}
                {doc.bones[id].name}
              </option>
            ))}
        </select>
      </div>
    </div>
  );
}

function FrameNumbers({ boneId, pose }: { boneId: string; pose: ReturnType<typeof evaluatePose> }) {
  const store = useStore();
  const state = useSyncExternalStore(store.subscribe, store.getState);
  const doc = state.history.present;
  const bone = doc.bones[boneId];
  const wb = findWorldBone(pose, boneId);
  const sampled = sampleTrack(doc.tracks[boneId], state.time, {
    angle: bone.angle,
    length: bone.length,
  });
  return (
    <div className="section">
      <h2>当前帧数值检查（t={state.time.toFixed(2)}s）</h2>
      <div className="check-nums">
        <span>局部角: {(sampled.angle * RAD).toFixed(1)}°（限位 {(bone.minAngle * RAD).toFixed(0)}°~{(bone.maxAngle * RAD).toFixed(0)}°）</span>
        <span>长度: {sampled.length.toFixed(1)}px</span>
        {wb && (
          <>
            <span>世界角: {(wb.worldAngle * RAD).toFixed(1)}°</span>
            <span>起点: ({wb.start.x.toFixed(1)}, {wb.start.y.toFixed(1)})</span>
            <span>末端: ({wb.end.x.toFixed(1)}, {wb.end.y.toFixed(1)})</span>
          </>
        )}
      </div>
    </div>
  );
}

function KeyframeActions({ bone }: { bone: Bone }) {
  const store = useStore();
  const state = useSyncExternalStore(store.subscribe, store.getState);
  const doc = state.history.present;
  const track = doc.tracks[bone.id] ?? [];
  const atCurrent = track.find((k) => Math.abs(k.time - state.time) < 1e-6);
  const pose = evaluatePose(doc, state.time, { rootPosition: state.rootPosition });
  const wb = findWorldBone(pose, bone.id);

  return (
    <div className="section">
      <h2>关键帧</h2>
      <div className="actions">
        <button
          className="primary"
          onClick={() =>
            store.setKeyframe(bone.id, state.time, {
              angle: wb?.localAngle ?? bone.angle,
              length: wb?.length ?? bone.length,
            })
          }
        >
          {atCurrent ? '更新当前帧' : '在当前时刻插入帧'}
        </button>
        <button
          className="danger"
          disabled={!atCurrent}
          onClick={() => store.deleteKeyframeAt(bone.id, state.time)}
        >
          删除当前帧
        </button>
      </div>
    </div>
  );
}

function DangerZone({ bone, depth }: { bone: Bone; depth: number }) {
  const store = useStore();
  return (
    <div className="section">
      <h2>删除</h2>
      <div className="actions">
        <button
          className="danger"
          onClick={() => {
            if (confirm(`删除「${bone.name}」及其全部子骨骼？该操作可撤销。`)) {
              store.deleteBone(bone.id, false);
            }
          }}
        >
          删除（级联子树）
        </button>
        {depth > 0 && (
          <button
            onClick={() => {
              if (confirm(`删除「${bone.name}」但保留子骨骼（子骨骼上移并保持世界方向）？`)) {
                store.deleteBone(bone.id, true);
              }
            }}
          >
            删除（保留子级）
          </button>
        )}
      </div>
    </div>
  );
}

function Issues() {
  const store = useStore();
  const issues = store.getSnapshot().issues;
  if (issues.length === 0) {
    return (
      <div className="section">
        <h2>完整性检查</h2>
        <div className="check-nums" style={{ color: 'var(--ok)' }}>✓ 无问题</div>
      </div>
    );
  }
  return (
    <div className="section">
      <h2>完整性检查（{issues.length}）</h2>
      <div className="issues">
        {issues.map((i, idx) => (
          <div key={idx} className={`issue ${i.level}`} title={i.code}>
            {i.level === 'error' ? '错误' : '警告'}：{i.message}
          </div>
        ))}
      </div>
    </div>
  );
}
