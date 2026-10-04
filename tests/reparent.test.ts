import { describe, expect, it } from 'vitest';
import { createEditorStore } from '../src/core/store';
import { evaluatePose, findWorldBone } from '../src/core/skeleton';
import {
  reparentKeepPose,
  type KeepPoseReparentErrorCode,
} from '../src/core/reparent';
import { exportSnapshot } from '../src/core/snapshot';
import { dist, normalizeAngle } from '../src/core/math2d';
import type { Bone, Keyframe, SkeletonDocument } from '../src/core/types';

interface TestBoneOptions {
  id: string;
  parentId: string | null;
  angle: number;
  length: number;
  minAngle?: number;
  maxAngle?: number;
}

function makeBone({
  id,
  parentId,
  angle,
  length,
  minAngle = -Math.PI,
  maxAngle = Math.PI,
}: TestBoneOptions): Bone {
  return { id, name: id, parentId, angle, length, minAngle, maxAngle };
}

function makeTrack(angle: number, length: number): Keyframe[] {
  return [
    { time: 0, angle, length },
    { time: 1, angle, length },
  ];
}

type TrackPatches = Partial<Record<string, Keyframe[]>>;

/**
 * 多级分支几何，根在 (100,100)：
 * r(→100) ─ p(↓50) ─ m(→50) ─ c1(↓30) ─ g(↓20)
 *        │                    └ c2(↑20)
 *        ├ q(↑40) ─ z(→15)
 *
 * m 旧末端为 (250,150)，q 末端为 (200,60)。
 */
function makeMultiBranchDoc(
  patches: Partial<Record<string, Partial<Bone>>> = {},
  trackPatches: TrackPatches = {}
): SkeletonDocument {
  const defs: TestBoneOptions[] = [
    { id: 'r', parentId: null, angle: 0, length: 100 },
    { id: 'p', parentId: 'r', angle: Math.PI / 2, length: 50 },
    { id: 'm', parentId: 'p', angle: -Math.PI / 2, length: 50 },
    { id: 'c1', parentId: 'm', angle: Math.PI / 2, length: 30 },
    { id: 'g', parentId: 'c1', angle: 0, length: 20 },
    { id: 'c2', parentId: 'm', angle: -Math.PI / 2, length: 20 },
    { id: 'q', parentId: 'r', angle: -Math.PI / 2, length: 40 },
    { id: 'z', parentId: 'q', angle: Math.PI / 2, length: 15 },
  ];
  const bones: SkeletonDocument['bones'] = {};
  for (const def of defs) {
    const bone = makeBone(def);
    Object.assign(bone, patches[def.id]);
    bones[def.id] = bone;
  }
  const tracks: SkeletonDocument['tracks'] = {};
  for (const bone of Object.values(bones)) {
    tracks[bone.id] = trackPatches[bone.id] ?? makeTrack(bone.angle, bone.length);
  }
  return { bones, rootId: 'r', tracks, duration: 2 };
}

const ROOT = { x: 100, y: 100 };
const TIME = 0.5;

function poseAt(doc: SkeletonDocument, time = TIME) {
  return evaluatePose(doc, time, { rootPosition: ROOT });
}

function expectFail(
  result: ReturnType<typeof reparentKeepPose>,
  code: KeepPoseReparentErrorCode
) {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.code).toBe(code);
}

describe('保持当前帧姿态改父', () => {
  it('多级骨骼改挂后：被移动骨末端及全部后代端点、世界方向保持不变', () => {
    const doc = makeMultiBranchDoc();
    const before = poseAt(doc);
    const expected = ['m', 'c1', 'c2', 'g'].map((id) => {
      const wb = findWorldBone(before, id)!;
      return {
        id,
        end: { ...wb.end },
        worldAngle: wb.worldAngle,
        localAngle: wb.localAngle,
        length: wb.length,
      };
    });

    const result = reparentKeepPose(doc, 'm', 'q', { time: TIME, rootPosition: ROOT });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.doc).not.toBe(doc);

    const after = poseAt(result.doc);
    expect(dist(findWorldBone(after, 'm')!.end, expected[0].end)).toBeLessThan(1e-9);
    for (const old of expected.slice(1)) {
      const next = findWorldBone(after, old.id)!;
      expect(dist(next.end, old.end)).toBeLessThan(1e-9);
      expect(Math.abs(normalizeAngle(next.worldAngle - old.worldAngle))).toBeLessThan(1e-9);
    }

    const moved = findWorldBone(after, 'm')!;
    const newParent = findWorldBone(after, 'q')!;
    expect(moved.start).toEqual({ x: 200, y: 60 });
    expect(moved.end).toEqual({ x: 250, y: 150 });
    expect(moved.length).toBeCloseTo(Math.hypot(50, 90), 9);
    expect(moved.worldAngle).toBeCloseTo(Math.atan2(90, 50), 9);
    expect(moved.localAngle).toBeCloseTo(Math.atan2(90, 50) + Math.PI / 2, 9);
    expect(newParent.end).toEqual({ x: 200, y: 60 });

    const c1 = findWorldBone(after, 'c1')!;
    const c2 = findWorldBone(after, 'c2')!;
    expect(c1.localAngle).toBeCloseTo(Math.PI / 2 - Math.atan2(90, 50), 9);
    expect(c2.localAngle).toBeCloseTo(-Math.PI / 2 - Math.atan2(90, 50), 9);
    expect(findWorldBone(after, 'g')!.localAngle).toBeCloseTo(0, 9);
    expect(result.doc.bones.m.parentId).toBe('q');
  });

  it('仅当前帧写入一笔关键帧事务；其它时刻仍按既有轨道插值播放', () => {
    const doc = makeMultiBranchDoc();
    const result = reparentKeepPose(doc, 'm', 'q', { time: TIME, rootPosition: ROOT });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    const next = result.doc;

    expect(next.tracks.m).toHaveLength(3);
    expect(next.tracks.c1).toHaveLength(3);
    expect(next.tracks.c2).toHaveLength(3);
    expect(next.tracks.g).toHaveLength(2);
    expect(next.tracks.q).toHaveLength(2);
    expect(next.tracks.m.find((k) => k.time === TIME)?.length).toBeCloseTo(
      Math.hypot(50, 90),
      9
    );

    // 静息骨骼定义和非当前轨道不被改写，承诺范围只限当前帧。
    expect(next.bones.m.angle).toBe(-Math.PI / 2);
    expect(next.bones.m.length).toBe(50);
    const poseOther = poseAt(next, 0);
    expect(dist(findWorldBone(poseOther, 'm')!.end, { x: 150, y: 60 })).toBeLessThan(1e-9);
  });

  it('所需新长度为零时整次拒绝，不修改结构或任何轨道', () => {
    const doc = makeMultiBranchDoc({
      q: {
        angle: Math.atan2(50, 50),
        length: Math.hypot(50, 50),
      },
    });
    // q 末端恰好是 m 的旧末端 (250,150)。
    expect(findWorldBone(poseAt(doc), 'q')!.end).toEqual({ x: 250, y: 150 });
    const tracksBefore = structuredClone(doc.tracks);

    const result = reparentKeepPose(doc, 'm', 'q', { time: TIME, rootPosition: ROOT });
    expectFail(result, 'zero-length');
    expect(doc.bones.m.parentId).toBe('p');
    expect(doc.tracks).toEqual(tracksBefore);
  });

  it('被移动骨或直接子骨补偿角越过限位时拒绝', () => {
    const blockedMoved = makeMultiBranchDoc({ m: { minAngle: -2, maxAngle: 2 } });
    expectFail(
      reparentKeepPose(blockedMoved, 'm', 'q', { time: TIME, rootPosition: ROOT }),
      'joint-limit'
    );
    expect(blockedMoved.bones.m.parentId).toBe('p');

    const blockedChild = makeMultiBranchDoc({ c2: { minAngle: -2, maxAngle: 2 } });
    expectFail(
      reparentKeepPose(blockedChild, 'm', 'q', { time: TIME, rootPosition: ROOT }),
      'joint-limit'
    );
    expect(blockedChild.tracks.m).toHaveLength(2);
    expect(blockedChild.tracks.c2).toHaveLength(2);
  });

  it('当前帧轨道本身越过限位时按非法文档拒绝', () => {
    const invalidPose = makeMultiBranchDoc(
      { m: { minAngle: -2, maxAngle: 2 } },
      { m: makeTrack(2.5, 50) }
    );
    const tracksBefore = structuredClone(invalidPose.tracks);
    expectFail(
      reparentKeepPose(invalidPose, 'm', 'q', { time: TIME, rootPosition: ROOT }),
      'invalid-document'
    );
    expect(invalidPose.tracks).toEqual(tracksBefore);
  });

  it('拒绝自身、后代、根和非法文档', () => {
    const doc = makeMultiBranchDoc();
    expectFail(reparentKeepPose(doc, 'm', 'm', { time: TIME, rootPosition: ROOT }), 'invalid-parent');
    expectFail(reparentKeepPose(doc, 'm', 'c1', { time: TIME, rootPosition: ROOT }), 'invalid-parent');
    expectFail(reparentKeepPose(doc, 'r', 'q', { time: TIME, rootPosition: ROOT }), 'cannot-reparent-root');

    const invalid = makeMultiBranchDoc();
    invalid.rootId = 'missing';
    expectFail(reparentKeepPose(invalid, 'm', 'q', { time: TIME, rootPosition: ROOT }), 'invalid-document');
    expect(invalid.bones.m.parentId).toBe('p');
  });

  it('通过 store 作为一条历史事务提交，并支持撤销重做', () => {
    const doc = makeMultiBranchDoc();
    const store = createEditorStore(doc);
    store.seek(TIME);
    const revBefore = store.getState().history.rev;
    const beforePose = poseAt(store.getDoc());
    const beforeParent = store.getDoc().bones.m.parentId;
    const beforeTrackSizes = Object.fromEntries(
      Object.entries(store.getDoc().tracks).map(([id, track]) => [id, track.length])
    );

    expect(store.reparentKeepPose('m', 'q')).toBe(true);
    const committed = store.getDoc();
    expect(store.getState().history.rev).toBe(revBefore + 1);
    expect(committed.bones.m.parentId).toBe('q');
    expect(committed.tracks.m).toHaveLength(3);
    expect(store.canUndo()).toBe(true);

    const afterPose = poseAt(committed);
    for (const id of ['m', 'c1', 'c2', 'g']) {
      expect(dist(findWorldBone(afterPose, id)!.end, findWorldBone(beforePose, id)!.end)).toBeLessThan(1e-9);
    }

    store.undo();
    expect(store.getState().history.rev).toBe(revBefore + 2);
    expect(store.getDoc().bones.m.parentId).toBe(beforeParent);
    for (const [id, size] of Object.entries(beforeTrackSizes)) {
      expect(store.getDoc().tracks[id]).toHaveLength(size);
    }
    const undonePose = poseAt(store.getDoc());
    for (const id of ['m', 'c1', 'c2', 'g']) {
      expect(dist(findWorldBone(undonePose, id)!.end, findWorldBone(beforePose, id)!.end)).toBeLessThan(1e-9);
    }

    store.redo();
    expect(store.getDoc()).toBe(committed);
    expect(store.getState().history.rev).toBe(revBefore + 3);
  });

  it('事务失败不推进修订，撤销栈与当前文档均保持原状', () => {
    const doc = makeMultiBranchDoc({
      q: { angle: Math.atan2(50, 50), length: Math.hypot(50, 50) },
    });
    const store = createEditorStore(doc);
    store.seek(TIME);
    const revBefore = store.getState().history.rev;
    const pastBefore = store.getState().history.past.length;
    const before = store.getDoc();

    expect(store.reparentKeepPose('m', 'q')).toBe(false);
    expect(store.getState().history.rev).toBe(revBefore);
    expect(store.getState().history.past.length).toBe(pastBefore);
    expect(store.getDoc()).toBe(before);
    expect(store.getDoc().bones.m.parentId).toBe('p');
  });

  it('改父提交形成新修订后，迟到的旧 IK 计算不会覆盖结果', async () => {
    const doc = makeMultiBranchDoc();
    const store = createEditorStore(doc);
    store.seek(TIME);
    store.beginDrag('m');
    const revBefore = store.getState().history.rev;

    store.gate.run(
      () => ({ x: 999, y: 999 }),
      () => {
        // 正常这里会写入旧拖动；修订失效时本回调不应执行。
        store.updateDrag({ x: 999, y: 999 });
      }
    );
    expect(store.reparentKeepPose('m', 'q')).toBe(true);
    expect(store.getState().drag).toBeNull();
    await Promise.resolve();
    await Promise.resolve();

    expect(store.getState().history.rev).toBe(revBefore + 1);
    expect(store.getDoc().bones.m.parentId).toBe('q');
    expect(store.getState().drag).toBeNull();
  });

  it('Canvas/检查器/导出生效的新修订一致，导出当前帧保留相同世界端点', () => {
    const doc = makeMultiBranchDoc();
    const store = createEditorStore(doc);
    store.seek(TIME);
    const before = poseAt(store.getDoc());
    expect(store.reparentKeepPose('m', 'q')).toBe(true);

    const snap = store.getSnapshot();
    const exported = exportSnapshot(snap, { sampleRate: 2, rootPosition: ROOT });
    expect(exported.rev).toBe(snap.rev);
    expect(exported.rev).toBe(store.getState().history.rev);

    const frame = exported.frames.find((f) => Math.abs(f.time - TIME) < 1e-9)!;
    for (const id of ['m', 'c1', 'c2', 'g']) {
      const oldEnd = findWorldBone(before, id)!.end;
      const exportedBone = frame.bones.find((b) => b.id === id)!;
      expect(dist(exportedBone.end, oldEnd)).toBeLessThan(1e-9);
    }
  });
});
