import type { Bone, SkeletonDocument, Vec2 } from './types';
import {
  boneCount,
  canReparent,
  createBone,
  deleteBoneCascade,
  deleteBonePromoteChildren,
  evaluatePose,
  findWorldBone,
  MAX_BONES,
  upsertKeyframe,
  removeKeyframe,
} from './skeleton';
import { getTwoBoneChain, solveTwoBoneIK } from './ik';
import {
  canRedo as historyCanRedo,
  canUndo as historyCanUndo,
  commit as historyCommit,
  initHistory,
  redo as historyRedo,
  touch as historyTouch,
  undo as historyUndo,
  type History,
} from './history';
import { RevisionGate } from './revision';
import { takeSnapshot, type RevisionSnapshot } from './snapshot';
import { createDefaultDocument } from './defaults';
import { clamp } from './math2d';

export interface DragSession {
  childId: string;
  /** 拖动开始前的文档，松手时只产生一条历史记录 */
  startDoc: SkeletonDocument;
  time: number;
  /** 最近一次 IK 是否因目标不可达而贴在边界 */
  clamped: boolean;
}

export interface EditorState {
  /** history.rev 是唯一的修订号来源 */
  history: History<SkeletonDocument>;
  time: number;
  playing: boolean;
  selection: string | null;
  rootPosition: Vec2;
  drag: DragSession | null;
  /** 最近一次 IK 解算贴边界的提示，供 UI 显示 */
  ikClamped: boolean;
}

export function createInitialState(doc?: SkeletonDocument): EditorState {
  const initial = doc ?? createDefaultDocument();
  return {
    history: initHistory(structuredClone(initial), 1),
    time: 0,
    playing: false,
    selection: initial.rootId,
    rootPosition: { x: 320, y: 380 },
    drag: null,
    ikClamped: false,
  };
}

export interface EditorStore {
  getState(): EditorState;
  getDoc(): SkeletonDocument;
  gate: RevisionGate;
  subscribe(listener: () => void): () => void;
  // 历史
  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;
  // 结构编辑
  addChildBone(parentId: string | null): string | null;
  deleteBone(boneId: string, promoteChildren: boolean): void;
  reparent(boneId: string, newParentId: string | null): boolean;
  updateBone(boneId: string, patch: Partial<Pick<Bone, 'name' | 'angle' | 'length' | 'minAngle' | 'maxAngle'>>): void;
  // 关键帧
  setKeyframe(boneId: string, time: number, values: { angle: number; length: number }): void;
  deleteKeyframeAt(boneId: string, time: number): void;
  setDuration(d: number): void;
  // 选择 / 播放
  select(id: string | null): void;
  play(): void;
  pause(): void;
  seek(t: number): void;
  tick(dtSeconds: number): void;
  // 姿态编辑（拖动）
  beginDrag(childId: string): void;
  /** 传入世界坐标目标点；返回本次是否真正接受了计算结果 */
  updateDrag(target: Vec2): boolean;
  endDrag(): void;
  cancelDrag(): void;
  /** 直接旋转单根骨骼（用于拖根骨骼末端或检查器角度编辑） */
  rotateBoneAtTime(boneId: string, localAngle: number, commitHistory?: boolean): void;
  // 统一快照
  getSnapshot(): RevisionSnapshot;
}

export function createEditorStore(initial?: SkeletonDocument): EditorStore {
  let state: EditorState = createInitialState(initial);
  const listeners = new Set<() => void>();
  const gate = new RevisionGate(state.history.rev);
  let snapshotCache: RevisionSnapshot | null = null;

  const emit = () => {
    for (const l of listeners) l();
  };

  /** 修订相关变更（文档改/撤销/重做/拖动中间帧）：推进 rev、失效快照与在途计算 */
  const replaceHistory = (nextHistory: History<SkeletonDocument>, extra?: Partial<EditorState>) => {
    state = { ...state, ...extra, history: nextHistory };
    gate.sync(nextHistory.rev);
    snapshotCache = null;
    emit();
  }

  /** 不产生新修订的 UI 状态变化（时间推进、播放暂停、选择） */
  const setView = (patch: Partial<EditorState>) => {
    state = { ...state, ...patch };
    emit();
  };

  /** 结构编辑/关键帧编辑：立即进历史。若拖动会话仍在进行，先丢弃它，
   *  避免 endDrag 用拖动前文档覆盖掉本次结构性修订。 */
  const commitDoc = (doc: SkeletonDocument, extra?: Partial<EditorState>) => {
    replaceHistory(historyCommit(state.history, doc), {
      playing: false,
      drag: null,
      ikClamped: false,
      ...extra,
    });
  };

  const store: EditorStore = {
    gate,

    getState: () => state,
    getDoc: () => state.history.present,
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },

    undo: () => {
      if (state.drag || !historyCanUndo(state.history)) return;
      replaceHistory(historyUndo(state.history), { playing: false });
    },
    redo: () => {
      if (state.drag || !historyCanRedo(state.history)) return;
      replaceHistory(historyRedo(state.history), { playing: false });
    },
    canUndo: () => historyCanUndo(state.history),
    canRedo: () => historyCanRedo(state.history),

    addChildBone: (parentId) => {
      const doc = state.history.present;
      if (boneCount(doc) >= MAX_BONES) return null;
      const bone = createBone({
        parentId,
        name: `骨骼 ${boneCount(doc) + 1}`,
        angle: 0.3,
        length: 50,
      });
      const bones = { ...doc.bones, [bone.id]: bone };
      const next: SkeletonDocument = {
        ...doc,
        bones,
        rootId: doc.rootId ?? bone.id,
        tracks: { ...doc.tracks, [bone.id]: [] },
      };
      commitDoc(next, { selection: bone.id });
      return bone.id;
    },

    deleteBone: (boneId, promoteChildren) => {
      const doc = state.history.present;
      if (!doc.bones[boneId]) return;
      const next = promoteChildren
        ? deleteBonePromoteChildren(doc, boneId)
        : deleteBoneCascade(doc, boneId);
      const selectionStillExists =
        state.selection !== null && state.selection !== boneId && !!next.bones[state.selection];
      commitDoc(next, { selection: selectionStillExists ? state.selection : next.rootId });
    },

    reparent: (boneId, newParentId) => {
      const doc = state.history.present;
      // 单根树约束：不允许摘为根（除非它本来就是根）
      if (newParentId === null && doc.bones[boneId]?.parentId !== null) return false;
      if (!canReparent(doc.bones, boneId, newParentId)) return false;
      const bone = doc.bones[boneId];
      const bones = { ...doc.bones, [boneId]: { ...bone, parentId: newParentId } };
      commitDoc({ ...doc, bones });
      return true;
    },

    updateBone: (boneId, patch) => {
      const doc = state.history.present;
      const bone = doc.bones[boneId];
      if (!bone) return;
      const merged: Bone = { ...bone, ...patch };
      if (patch.length !== undefined) merged.length = Math.max(1, patch.length);
      if (patch.minAngle !== undefined && merged.minAngle > merged.maxAngle) {
        merged.maxAngle = merged.minAngle;
      }
      if (patch.maxAngle !== undefined && merged.maxAngle < merged.minAngle) {
        merged.minAngle = merged.maxAngle;
      }
      merged.angle = clampAngleToBone(merged.angle, merged);
      const bones = { ...doc.bones, [boneId]: merged };
      // 已有关键帧角度也夹到新限位
      const tracks = { ...doc.tracks };
      if (tracks[boneId]) {
        tracks[boneId] = tracks[boneId].map((k) => ({
          ...k,
          angle: clampAngleToBone(k.angle, merged),
        }));
      }
      commitDoc({ ...doc, bones, tracks });
    },

    setKeyframe: (boneId, time, values) => {
      const doc = state.history.present;
      const bone = doc.bones[boneId];
      if (!bone) return;
      const track = doc.tracks[boneId] ?? [];
      const tracks = {
        ...doc.tracks,
        [boneId]: upsertKeyframe(track, { time, angle: values.angle, length: values.length }, bone),
      };
      commitDoc({ ...doc, tracks });
    },

    deleteKeyframeAt: (boneId, time) => {
      const doc = state.history.present;
      const track = doc.tracks[boneId];
      if (!track) return;
      const tracks = { ...doc.tracks, [boneId]: removeKeyframe(track, time) };
      commitDoc({ ...doc, tracks });
    },

    setDuration: (d) => {
      const duration = Math.max(0.1, d);
      const doc = state.history.present;
      // 裁剪超出新时长的关键帧，不留越界帧
      const tracks: SkeletonDocument['tracks'] = {};
      for (const [id, kfs] of Object.entries(doc.tracks)) {
        tracks[id] = kfs.filter((k) => k.time <= duration + 1e-9).map((k) => ({ ...k }));
      }
      commitDoc({ ...doc, duration, tracks });
    },

    select: (id) => {
      if (id !== state.selection) setView({ selection: id });
    },
    play: () => {
      if (state.playing) return;
      const restart = state.time >= state.history.present.duration - 1e-9;
      setView({ playing: true, time: restart ? 0 : state.time });
    },
    pause: () => {
      if (state.playing) setView({ playing: false });
    },
    seek: (t) => {
      const duration = state.history.present.duration;
      setView({ time: clamp(t, 0, duration), playing: false });
    },
    tick: (dt) => {
      if (!state.playing) return;
      const duration = state.history.present.duration;
      const t = state.time + dt;
      if (t >= duration) setView({ time: duration, playing: false });
      else setView({ time: t });
    },

    beginDrag: (childId) => {
      if (state.drag || !state.history.present.bones[childId]) return;
      setView({
        playing: false,
        selection: childId,
        ikClamped: false,
        drag: {
          childId,
          startDoc: state.history.present,
          time: state.time,
          clamped: false,
        },
      });
    },

    updateDrag: (target) => {
      const session = state.drag;
      if (!session) return false;
      const doc = state.history.present;
      const pose = evaluatePose(doc, session.time, { rootPosition: state.rootPosition });
      const dragged = findWorldBone(pose, session.childId);
      if (!dragged) return false;

      let nextDoc: SkeletonDocument;
      let clamped = false;

      if (dragged.parentId === null) {
        // 根骨骼：单骨旋转，末端指向目标
        const bone = doc.bones[dragged.id];
        const angle = Math.atan2(
          target.y - state.rootPosition.y,
          target.x - state.rootPosition.x
        );
        nextDoc = applyBoneAngles(doc, session.time, [
          { boneId: dragged.id, localAngle: clampAngleToBone(angle, bone), length: dragged.length },
        ]);
      } else {
        const chain = getTwoBoneChain(doc, pose, session.childId);
        if (!chain) return false;
        const preferredBend: 1 | -1 = chain.child.localAngle < -1e-6 ? -1 : 1;
        const result = solveTwoBoneIK(
          chain.parent.start,
          chain.parent.length,
          chain.child.length,
          target,
          {
            parentMin: chain.parentBone.minAngle,
            parentMax: chain.parentBone.maxAngle,
            childMin: chain.childBone.minAngle,
            childMax: chain.childBone.maxAngle,
            grandparentWorldAngle: chain.grandparentWorldAngle,
            preferredBend,
          }
        );
        clamped = result.clamped;
        nextDoc = applyBoneAngles(doc, session.time, [
          { boneId: chain.parent.id, localAngle: result.parentAngle, length: chain.parent.length },
          { boneId: chain.child.id, localAngle: result.childAngle, length: chain.child.length },
        ]);
      }

      // 拖动中间帧：present 更新 + rev 递增（拦截迟到计算），不产生撤销条目
      state = {
        ...state,
        history: historyTouch(state.history, nextDoc),
        drag: { ...session, clamped },
        ikClamped: clamped,
      };
      gate.sync(state.history.rev);
      snapshotCache = null;
      emit();
      return true;
    },

    endDrag: () => {
      const session = state.drag;
      if (!session) return;
      const finalDoc = state.history.present;
      if (finalDoc === session.startDoc) {
        // 未改动：恢复，不产生历史
        state = { ...state, drag: null, history: { ...state.history, present: session.startDoc } };
      } else {
        // 整个拖动合并为一条历史记录：past 压入 startDoc，丢弃中间 rev
        state = {
          ...state,
          drag: null,
          history: {
            past: [...state.history.past, session.startDoc].slice(-200),
            present: finalDoc,
            future: [],
            rev: state.history.rev + 1,
          },
        };
      }
      gate.sync(state.history.rev);
      snapshotCache = null;
      emit();
    },

    cancelDrag: () => {
      const session = state.drag;
      if (!session) return;
      // ESC 取消：修订号也推进，使取消前在途的计算结果失效
      state = {
        ...state,
        drag: null,
        ikClamped: false,
        history: historyTouch(state.history, session.startDoc),
      };
      gate.sync(state.history.rev);
      snapshotCache = null;
      emit();
    },

    rotateBoneAtTime: (boneId, localAngle, commitHistoryFlag = true) => {
      const doc = state.history.present;
      const bone = doc.bones[boneId];
      if (!bone) return;
      const pose = evaluatePose(doc, state.time, { rootPosition: state.rootPosition });
      const wb = findWorldBone(pose, boneId);
      const next = applyBoneAngles(doc, state.time, [
        { boneId, localAngle: clampAngleToBone(localAngle, bone), length: wb?.length ?? bone.length },
      ]);
      if (commitHistoryFlag) commitDoc(next);
      else replaceHistory(historyTouch(state.history, next));
    },

    getSnapshot: () => {
      if (!snapshotCache || snapshotCache.rev !== state.history.rev) {
        snapshotCache = takeSnapshot(state.history.rev, state.history.present);
      }
      return snapshotCache;
    },
  };

  return store;
}

function clampAngleToBone(angle: number, bone: Bone): number {
  if (!(bone.maxAngle >= bone.minAngle)) return bone.minAngle;
  return Math.min(bone.maxAngle, Math.max(bone.minAngle, angle));
}

interface AngleAtTime {
  boneId: string;
  localAngle: number;
  length: number;
}

/**
 * 把 IK 求得的局部角度写为当前时刻的关键帧。
 * 长度保持该时刻采样值（IK 不改变骨长）。
 */
function applyBoneAngles(
  doc: SkeletonDocument,
  time: number,
  values: AngleAtTime[]
): SkeletonDocument {
  const tracks = { ...doc.tracks };
  const bones = { ...doc.bones };
  for (const v of values) {
    const bone = doc.bones[v.boneId];
    if (!bone) continue;
    const angle = clampAngleToBone(v.localAngle, bone);
    const track = tracks[v.boneId] ?? [];
    tracks[v.boneId] = upsertKeyframe(
      track,
      { time, angle, length: Math.max(1, v.length) },
      bone
    );
    // 同步静态姿态，使没有关键帧的位置也保持新角度
    bones[v.boneId] = { ...bone, angle };
  }
  return { ...doc, tracks, bones };
}
