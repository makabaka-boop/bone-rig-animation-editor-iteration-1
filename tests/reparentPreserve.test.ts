import { describe, expect, it } from 'vitest';
import { createEditorStore, type EditorStore } from '../src/core/store';
import {
  createBone,
  evaluatePose,
  findWorldBone,
  reparentBonePreservePose,
} from '../src/core/skeleton';
import { exportSnapshot } from '../src/core/snapshot';
import { hasErrors, validateDocument } from '../src/core/validation';
import { dist, normalizeAngle } from '../src/core/math2d';
import type { SkeletonDocument, WorldBone } from '../src/core/types';

/**
 * 多级几何模型（rootPosition 无关，相对坐标）：
 * ```
 * root(0°)──arm(0°)──hand(90°)──finger(0°)
 *   │            └─probe(90°，末端与 hand 末端重合)
 *   └─leg(90°)
 * ```
 * root 长 100、arm 长 80、hand 长 50、finger 长 20、leg 长 90、probe 长 50。
 */
function makeDoc(): { doc: SkeletonDocument; ids: Record<string, string> } {
  const root = createBone({ name: 'root', parentId: null, angle: 0, length: 100 });
  const arm = createBone({ name: 'arm', parentId: root.id, angle: 0, length: 80 });
  const hand = createBone({ name: 'hand', parentId: arm.id, angle: Math.PI / 2, length: 50 });
  const finger = createBone({ name: 'finger', parentId: hand.id, angle: 0, length: 20 });
  const leg = createBone({ name: 'leg', parentId: root.id, angle: Math.PI / 2, length: 90 });
  const probe = createBone({ name: 'probe', parentId: arm.id, angle: Math.PI / 2, length: 50 });
  const bones = Object.fromEntries(
    [root, arm, hand, finger, leg, probe].map((b) => [b.id, b])
  );
  return {
    doc: { bones, rootId: root.id, tracks: {}, duration: 2 },
    ids: { root: root.id, arm: arm.id, hand: hand.id, finger: finger.id, leg: leg.id, probe: probe.id },
  };
}

function worldOf(s: EditorStore, id: string, time = 0): WorldBone {
  const pose = evaluatePose(s.getDoc(), time, { rootPosition: s.getState().rootPosition });
  return findWorldBone(pose, id)!;
}

describe('保持当前帧姿态的改父：几何保持（多级模型）', () => {
  it('改父后当前帧被移动骨末端及后代的世界端点、方向不变', () => {
    const { doc, ids } = makeDoc();
    const s = createEditorStore(doc);
    s.seek(0);
    const before = {
      hand: worldOf(s, ids.hand),
      finger: worldOf(s, ids.finger),
      leg: worldOf(s, ids.leg),
      arm: worldOf(s, ids.arm),
    };

    expect(s.reparentPreservePose(ids.hand, ids.leg)).toBe(true);
    expect(s.getDoc().bones[ids.hand].parentId).toBe(ids.leg);

    const afterHand = worldOf(s, ids.hand);
    const afterFinger = worldOf(s, ids.finger);
    // 被移动骨的新起点 = 新父末端
    expect(dist(afterHand.start, before.leg.end)).toBeLessThan(1e-9);
    // 被移动骨末端不动
    expect(dist(afterHand.end, before.hand.end)).toBeLessThan(1e-9);
    // 后代（finger）的世界端点与方向不动
    expect(dist(afterFinger.start, before.finger.start)).toBeLessThan(1e-9);
    expect(dist(afterFinger.end, before.finger.end)).toBeLessThan(1e-9);
    expect(afterFinger.worldAngle).toBeCloseTo(before.finger.worldAngle, 9);
    // 新长度 = 新父末端到旧末端的距离 |(80,-40)| = √8000
    expect(afterHand.length).toBeCloseTo(Math.hypot(80, 40), 9);
    // 新局部角 = atan2(-40, 80) − 新父世界角(π/2)
    expect(afterHand.localAngle).toBeCloseTo(
      normalizeAngle(Math.atan2(-40, 80) - Math.PI / 2),
      9
    );
    // 未涉及的骨骼姿态不变
    expect(dist(worldOf(s, ids.arm).end, before.arm.end)).toBeLessThan(1e-9);
    expect(dist(worldOf(s, ids.leg).end, before.leg.end)).toBeLessThan(1e-9);
    // 结果文档通过完整性检查
    expect(hasErrors(validateDocument(s.getDoc()))).toBe(false);
  });

  it('写入当前时刻关键帧：被移动骨新局部角/长度，直接子骨补偿角，其余轨道不动', () => {
    const { doc, ids } = makeDoc();
    const s = createEditorStore(doc);
    s.seek(0);
    expect(s.reparentPreservePose(ids.hand, ids.leg)).toBe(true);
    const tracks = s.getDoc().tracks;

    const handKfs = tracks[ids.hand];
    expect(handKfs).toHaveLength(1);
    expect(handKfs[0].time).toBe(0);
    expect(handKfs[0].length).toBeCloseTo(Math.hypot(80, 40), 9);
    expect(handKfs[0].angle).toBeCloseTo(normalizeAngle(Math.atan2(-40, 80) - Math.PI / 2), 9);

    // finger 的补偿角 = 旧世界角(π/2) − 被移动骨新世界角(atan2(-40,80))
    const fingerKfs = tracks[ids.finger];
    expect(fingerKfs).toHaveLength(1);
    expect(fingerKfs[0].time).toBe(0);
    expect(fingerKfs[0].angle).toBeCloseTo(
      normalizeAngle(Math.PI / 2 - Math.atan2(-40, 80)),
      9
    );
    expect(fingerKfs[0].length).toBeCloseTo(20, 9); // 子骨长度不变

    // 其余骨骼不写关键帧
    expect(tracks[ids.root] ?? []).toHaveLength(0);
    expect(tracks[ids.arm] ?? []).toHaveLength(0);
    expect(tracks[ids.leg] ?? []).toHaveLength(0);
    expect(tracks[ids.probe] ?? []).toHaveLength(0);
  });

  it('只承诺当前帧：其他时刻仍按既有插值播放', () => {
    const { doc, ids } = makeDoc();
    // hand 既有轨道：t=0 局部 0，t=2 局部 π/2（t=1 插值为 π/4）
    doc.tracks[ids.hand] = [
      { time: 0, angle: 0, length: 50 },
      { time: 2, angle: Math.PI / 2, length: 50 },
    ];
    const s = createEditorStore(doc);
    s.seek(1);
    const handBefore1 = worldOf(s, ids.hand, 1);
    const fingerBefore1 = worldOf(s, ids.finger, 1);
    const handBefore0 = worldOf(s, ids.hand, 0);

    expect(s.reparentPreservePose(ids.hand, ids.leg)).toBe(true);
    // 关键帧写在当前时刻 t=1
    expect(s.getDoc().tracks[ids.hand].some((k) => k.time === 1)).toBe(true);
    // 当前帧保持
    expect(dist(worldOf(s, ids.hand, 1).end, handBefore1.end)).toBeLessThan(1e-9);
    expect(dist(worldOf(s, ids.finger, 1).end, fingerBefore1.end)).toBeLessThan(1e-9);
    // 其他时刻不承诺：t=0 仍按旧局部角插值，但父级已变，世界位置不同
    expect(dist(worldOf(s, ids.hand, 0).end, handBefore0.end)).toBeGreaterThan(1);
  });
});

describe('保持当前帧姿态的改父：整次拒绝', () => {
  it('所需长度为零（新父末端与被移动骨末端重合）时拒绝，不留任何修改', () => {
    const { doc, ids } = makeDoc();
    const s = createEditorStore(doc);
    s.seek(0);
    // probe 末端与 hand 末端重合 → 新长度为零
    expect(dist(worldOf(s, ids.probe).end, worldOf(s, ids.hand).end)).toBeLessThan(1e-9);
    const rev = s.getState().history.rev;
    expect(s.reparentPreservePose(ids.hand, ids.probe)).toBe(false);
    expect(s.getState().history.rev).toBe(rev);
    expect(s.getDoc().bones[ids.hand].parentId).toBe(ids.arm);
    expect(s.getDoc().tracks[ids.hand] ?? []).toHaveLength(0);
    expect(s.getDoc().tracks[ids.finger] ?? []).toHaveLength(0);
  });

  it('被移动骨新局部角越过关节限位时拒绝', () => {
    const { doc, ids } = makeDoc();
    const s = createEditorStore(doc);
    s.updateBone(ids.hand, { minAngle: -0.1, maxAngle: 0.1 });
    const rev = s.getState().history.rev;
    // 需要的局部角 ≈ -2.03rad，越界
    expect(s.reparentPreservePose(ids.hand, ids.leg)).toBe(false);
    expect(s.getState().history.rev).toBe(rev);
    expect(s.getDoc().bones[ids.hand].parentId).toBe(ids.arm);
    expect(s.getDoc().tracks[ids.hand] ?? []).toHaveLength(0);
  });

  it('直接子骨补偿角越过限位时整次拒绝：被移动骨也不写关键帧', () => {
    const { doc, ids } = makeDoc();
    const s = createEditorStore(doc);
    // finger 补偿角 ≈ +2.03rad，把上限压到 1.0
    s.updateBone(ids.finger, { maxAngle: 1 });
    const rev = s.getState().history.rev;
    expect(s.reparentPreservePose(ids.hand, ids.leg)).toBe(false);
    expect(s.getState().history.rev).toBe(rev);
    expect(s.getDoc().bones[ids.hand].parentId).toBe(ids.arm);
    // 原子性：被移动骨与子骨都没有留下部分轨道修改
    expect(s.getDoc().tracks[ids.hand] ?? []).toHaveLength(0);
    expect(s.getDoc().tracks[ids.finger] ?? []).toHaveLength(0);
  });

  it('目标是自身或后代（成环）、非根骨摘为根时被拒绝', () => {
    const { doc, ids } = makeDoc();
    const s = createEditorStore(doc);
    expect(s.reparentPreservePose(ids.hand, ids.hand)).toBe(false); // 自身
    expect(s.reparentPreservePose(ids.hand, ids.finger)).toBe(false); // 直接后代
    expect(s.reparentPreservePose(ids.arm, ids.finger)).toBe(false); // 间接后代
    expect(s.reparentPreservePose(ids.hand, null)).toBe(false); // 非根骨摘为根
    expect(s.getDoc().bones[ids.hand].parentId).toBe(ids.arm);
  });

  it('文档不合法时拒绝', () => {
    const { doc, ids } = makeDoc();
    // 制造非法文档：骨骼长度非正（validateDocument 报 bad-length）
    doc.bones[ids.arm] = { ...doc.bones[ids.arm], length: 0 };
    const s = createEditorStore(doc);
    expect(hasErrors(validateDocument(s.getDoc()))).toBe(true);
    const rev = s.getState().history.rev;
    expect(s.reparentPreservePose(ids.hand, ids.leg)).toBe(false);
    expect(s.getState().history.rev).toBe(rev);
    expect(s.getDoc().bones[ids.hand].parentId).toBe(ids.arm);
  });

  it('纯函数层面对同一帧几何给出一致结果，失败返回 null', () => {
    const { doc, ids } = makeDoc();
    const ok = reparentBonePreservePose(doc, ids.hand, ids.leg, 0, {
      rootPosition: { x: 0, y: 0 },
    });
    expect(ok).not.toBeNull();
    expect(ok!.bones[ids.hand].parentId).toBe(ids.leg);
    expect(reparentBonePreservePose(doc, ids.hand, ids.probe, 0)).toBeNull(); // 零长度
    expect(reparentBonePreservePose(doc, ids.hand, ids.finger, 0)).toBeNull(); // 后代
    expect(reparentBonePreservePose(doc, ids.hand, null, 0)).toBeNull(); // 摘根
    // 父子关系不变是无操作
    expect(reparentBonePreservePose(doc, ids.hand, ids.arm, 0)).toBe(doc);
  });
});

describe('保持当前帧姿态的改父：历史与修订', () => {
  it('一笔可撤销事务：undo 恢复父子关系与轨道，redo 重放仍保持该帧姿态', () => {
    const { doc, ids } = makeDoc();
    const s = createEditorStore(doc);
    s.seek(0);
    const pastLen = s.getState().history.past.length;
    const handBefore = worldOf(s, ids.hand);
    const fingerBefore = worldOf(s, ids.finger);

    expect(s.reparentPreservePose(ids.hand, ids.leg)).toBe(true);
    // 整个操作只产生一条历史记录
    expect(s.getState().history.past.length).toBe(pastLen + 1);

    s.undo();
    expect(s.getDoc().bones[ids.hand].parentId).toBe(ids.arm);
    expect(s.getDoc().tracks[ids.hand] ?? []).toHaveLength(0);
    expect(s.getDoc().tracks[ids.finger] ?? []).toHaveLength(0);
    expect(dist(worldOf(s, ids.hand).end, handBefore.end)).toBeLessThan(1e-9);

    s.redo();
    expect(s.getDoc().bones[ids.hand].parentId).toBe(ids.leg);
    expect(dist(worldOf(s, ids.hand).end, handBefore.end)).toBeLessThan(1e-9);
    expect(dist(worldOf(s, ids.finger).end, fingerBefore.end)).toBeLessThan(1e-9);
  });

  it('树模型、快照与导出共用新修订；迟到的旧 IK 不得覆盖结果', async () => {
    const { doc, ids } = makeDoc();
    const s = createEditorStore(doc);
    s.seek(0);
    const handBefore = worldOf(s, ids.hand);

    // 在途的迟到 IK 计算（旧修订号）
    let delivered = false;
    s.gate.run(() => 'late-ik', () => {
      delivered = true;
    });

    const revBefore = s.getState().history.rev;
    expect(s.reparentPreservePose(ids.hand, ids.leg)).toBe(true);
    expect(s.getState().history.rev).toBeGreaterThan(revBefore);

    // 快照与导出取自同一新修订
    const snap = s.getSnapshot();
    expect(snap.rev).toBe(s.getState().history.rev);
    expect(snap.doc.bones[ids.hand].parentId).toBe(ids.leg);
    const data = exportSnapshot(snap, { rootPosition: s.getState().rootPosition });
    expect(data.rev).toBe(snap.rev);
    const frame0 = data.frames.find((f) => f.time === 0)!;
    const handExport = frame0.bones.find((b) => b.id === ids.hand)!;
    expect(handExport.end.x).toBeCloseTo(handBefore.end.x, 9);
    expect(handExport.end.y).toBeCloseTo(handBefore.end.y, 9);

    // 迟到的计算结果被丢弃
    await Promise.resolve();
    await Promise.resolve();
    expect(delivered).toBe(false);
    // 修订未被覆盖
    expect(s.getDoc().bones[ids.hand].parentId).toBe(ids.leg);
    expect(dist(worldOf(s, ids.hand).end, handBefore.end)).toBeLessThan(1e-9);
  });

  it('拖动进行中执行保持姿态改父：拖动会话被丢弃，endDrag 不覆盖结果', () => {
    const { doc, ids } = makeDoc();
    const s = createEditorStore(doc);
    s.seek(0);
    s.beginDrag(ids.finger);
    s.updateDrag({ x: 500, y: 500 });
    expect(s.getState().drag).not.toBeNull();
    const pastLen = s.getState().history.past.length;
    const handMid = worldOf(s, ids.hand);

    expect(s.reparentPreservePose(ids.hand, ids.leg)).toBe(true);
    // 结构编辑丢弃拖动会话
    expect(s.getState().drag).toBeNull();
    // 松手不再产生历史，也不回滚本次改父
    s.endDrag();
    expect(s.getState().history.past.length).toBe(pastLen + 1);
    expect(s.getDoc().bones[ids.hand].parentId).toBe(ids.leg);
    // 当前帧（拖动中间态）的姿态被保持
    expect(dist(worldOf(s, ids.hand).end, handMid.end)).toBeLessThan(1e-9);
  });
});
