import { describe, expect, it } from 'vitest';
import { createEditorStore } from '../src/core/store';
import { evaluatePose, findWorldBone } from '../src/core';
import { dist } from '../src/core/math2d';
import { canReparent, deleteBoneCascade } from '../src/core/skeleton';
import { validateDocument, hasErrors } from '../src/core/validation';

describe('结构编辑约束', () => {
  it('不能把骨骼挂到自身', () => {
    const s = createEditorStore();
    const id = Object.keys(s.getDoc().bones)[0];
    expect(canReparent(s.getDoc().bones, id, id)).toBe(false);
  });

  it('不能把祖先挂到后代（防环）', () => {
    const s = createEditorStore();
    const ids = Object.keys(s.getDoc().bones); // 根->上臂->前臂->手
    const [root, arm, fore] = ids;
    // 试图把根挂到前臂下：前臂是根的后代
    expect(canReparent(s.getDoc().bones, root, fore)).toBe(false);
    // 挂到兄弟分支允许（本例线性链下前臂挂根 = 回到祖先链，合法）
    expect(canReparent(s.getDoc().bones, fore, arm)).toBe(true);
  });

  it('reparent 拒绝形成环的操作且文档不变', () => {
    const s = createEditorStore();
    const [root, , fore] = Object.keys(s.getDoc().bones);
    const revBefore = s.getState().history.rev;
    expect(s.reparent(root, fore)).toBe(false);
    expect(s.getState().history.rev).toBe(revBefore);
  });

  it('删除骨骼级联清理子树与关键帧，不留下引用已删除骨骼的帧', () => {
    const s = createEditorStore();
    const [, arm, fore, hand] = Object.keys(s.getDoc().bones);
    s.deleteBone(fore, false);
    const doc = s.getDoc();
    expect(doc.bones[fore]).toBeUndefined();
    expect(doc.bones[hand]).toBeUndefined();
    expect(doc.tracks[fore]).toBeUndefined();
    expect(doc.tracks[hand]).toBeUndefined();
    // 所有轨道都有对应骨骼
    for (const id of Object.keys(doc.tracks)) expect(doc.bones[id]).toBeDefined();
    expect(hasErrors(validateDocument(doc))).toBe(false);
  });

  it('删除根后文档不残留悬挂引用', () => {
    const s = createEditorStore();
    const root = s.getDoc().rootId!;
    const next = deleteBoneCascade(s.getDoc(), root);
    expect(hasErrors(validateDocument(next))).toBe(true); // 全删后无根，报错而非崩溃
    expect(Object.keys(next.bones)).toHaveLength(0);
  });

  it('骨骼数量上限 15', async () => {
    const { MAX_BONES } = await import('../src/core/skeleton');
    const s = createEditorStore();
    let lastParent = s.getDoc().rootId!;
    // 默认 4 根，再加 11 根到 15
    for (let i = 0; i < MAX_BONES - 4; i++) {
      const id = s.addChildBone(lastParent);
      expect(id).not.toBeNull();
      lastParent = id!;
    }
    expect(s.addChildBone(lastParent)).toBeNull();
    expect(Object.keys(s.getDoc().bones)).toHaveLength(15);
  });
});

describe('约束边界（通过 store 的拖动）', () => {
  it('拖动到不可达位置：clamped 置位且末端在最大可达圆上', () => {
    const s = createEditorStore();
    const [, arm, fore] = Object.keys(s.getDoc().bones);
    // 拖「前臂」末端：链为 上臂(60)+前臂(55)，肩为根的终点
    s.seek(0);
    s.beginDrag(fore);
    const accepted = s.updateDrag({ x: 5000, y: 5000 });
    expect(accepted).toBe(true);
    expect(s.getState().ikClamped).toBe(true);
    const pose = evaluatePose(s.getDoc(), 0, {
      rootPosition: s.getState().rootPosition,
    });
    const parent = findWorldBone(pose, arm)!;
    const child = findWorldBone(pose, fore)!;
    expect(dist(parent.start, child.end)).toBeCloseTo(115, 6);
    s.endDrag();
  });

  it('限位区间改动后，IK 结果不越界（前臂只能弯到 -2.6..0.2）', () => {
    const s = createEditorStore();
    const [, arm, fore] = Object.keys(s.getDoc().bones);
    s.updateBone(fore, { minAngle: -0.5, maxAngle: -0.2 });
    s.seek(0);
    s.beginDrag(fore);
    s.updateDrag({ x: 1000, y: 0 }); // 努力朝一侧伸直
    s.updateDrag({ x: -1000, y: 0 });
    s.updateDrag({ x: 200, y: 600 });
    s.endDrag();
    const pose = evaluatePose(s.getDoc(), 0, {
      rootPosition: s.getState().rootPosition,
    });
    const child = findWorldBone(pose, fore)!;
    expect(child.localAngle).toBeGreaterThanOrEqual(-0.5 - 1e-6);
    expect(child.localAngle).toBeLessThanOrEqual(-0.2 + 1e-6);
    // 上臂也在其限位内
    const parent = findWorldBone(pose, arm)!;
    const bone = s.getDoc().bones[arm];
    expect(parent.localAngle).toBeGreaterThanOrEqual(bone.minAngle - 1e-6);
    expect(parent.localAngle).toBeLessThanOrEqual(bone.maxAngle + 1e-6);
  });

  it('可达目标下末端精确命中且 clamped=false', () => {
    const s = createEditorStore();
    const [, arm, fore] = Object.keys(s.getDoc().bones);
    s.seek(0);
    const pose0 = evaluatePose(s.getDoc(), 0, { rootPosition: s.getState().rootPosition });
    const shoulder = findWorldBone(pose0, arm)!.start;
    const currentEE = findWorldBone(pose0, fore)!.end;
    s.beginDrag(fore);
    // 目标 = 当前末端沿肘->端方向再移 8：连续可达且保持当前弯折侧，不会撞到限位
    const dx = currentEE.x - shoulder.x;
    const dy = currentEE.y - shoulder.y;
    const dl = Math.hypot(dx, dy);
    const target = { x: currentEE.x + (dx / dl) * 8, y: currentEE.y + (dy / dl) * 8 };
    s.updateDrag(target);
    expect(s.getState().ikClamped).toBe(false);
    s.endDrag();
    const pose = evaluatePose(s.getDoc(), 0, { rootPosition: s.getState().rootPosition });
    const ee = findWorldBone(pose, fore)!.end;
    expect(dist(ee, target)).toBeLessThan(1e-6);
  });
});

describe('撤销 / 重做与重播', () => {
  it('一次拖动只产生一条历史，undo 恢复拖动前姿态', () => {
    const s = createEditorStore();
    const [, , fore] = Object.keys(s.getDoc().bones);
    const before = s.getState().history.rev;
    const pastBefore = s.getState().history.past.length;
    s.seek(0);
    s.beginDrag(fore);
    s.updateDrag({ x: 900, y: 900 });
    s.updateDrag({ x: 950, y: 850 });
    s.updateDrag({ x: 800, y: 700 });
    // 拖动中间帧推进修订号（防止迟到结果覆盖），但不产生撤销条目
    expect(s.getState().history.rev).toBe(before + 3);
    expect(s.getState().history.past.length).toBe(pastBefore);
    s.endDrag();
    // 整个拖动只产生一条历史记录
    expect(s.getState().history.past.length).toBe(pastBefore + 1);
    expect(s.canUndo()).toBe(true);
    const poseBefore = evaluatePose(s.getDoc(), 0, { rootPosition: s.getState().rootPosition });
    s.undo();
    const poseAfter = evaluatePose(s.getDoc(), 0, { rootPosition: s.getState().rootPosition });
    // 至少被拖动骨的末端恢复
    const beforeEE = poseBefore.find((w) => w.id === fore)!.end;
    const afterEE = poseAfter.find((w) => w.id === fore)!.end;
    expect(dist(beforeEE, afterEE)).toBeGreaterThan(1);
    s.redo();
    const poseRedo = evaluatePose(s.getDoc(), 0, { rootPosition: s.getState().rootPosition });
    expect(dist(poseRedo.find((w) => w.id === fore)!.end, beforeEE)).toBeLessThan(1e-9);
  });

  it('撤销后重播：关键帧序列与撤销前版本一致地逐帧求值', () => {
    const s = createEditorStore();
    const doc0 = s.getDoc();
    const [, arm, fore] = Object.keys(doc0.bones);
    s.seek(0);
    s.beginDrag(fore);
    s.updateDrag({ x: 700, y: 700 });
    s.endDrag();
    // 记录撤销前 0/0.5/1/1.5/2 的姿态
    const sampleAll = () =>
      [0, 0.5, 1, 1.5, 2].map((t) =>
        evaluatePose(s.getDoc(), t, { rootPosition: s.getState().rootPosition })
          .find((w) => w.id === arm)!.worldAngle
      );
    const modified = sampleAll();
    s.undo();
    const restored = sampleAll();
    expect(restored.some((v, i) => Math.abs(v - modified[i]) > 1e-6)).toBe(true);
    s.redo();
    expect(sampleAll().every((v, i) => Math.abs(v - modified[i]) < 1e-9)).toBe(true);
  });

  it('拖动中撤销被忽略；取消拖动不产生历史条目', () => {
    const s = createEditorStore();
    const [, , fore] = Object.keys(s.getDoc().bones);
    const undoCountBefore = s.getState().history.past.length;
    s.beginDrag(fore);
    s.updateDrag({ x: 900, y: 200 });
    s.undo(); // 拖动中无效
    expect(s.getState().history.past.length).toBe(undoCountBefore);
    s.cancelDrag();
    expect(s.getState().history.past.length).toBe(undoCountBefore);
    expect(s.canUndo()).toBe(false);
  });

  it('拖动中进行结构编辑：拖动会话被丢弃，不覆盖结构修订', () => {
    const s = createEditorStore();
    const root = s.getDoc().rootId!;
    const [, , fore] = Object.keys(s.getDoc().bones);
    s.beginDrag(fore);
    s.updateDrag({ x: 900, y: 300 });
    const countDuringDrag = Object.keys(s.getDoc().bones).length;
    // 拖动过程中从工具栏/树新增骨骼
    const newId = s.addChildBone(root)!;
    expect(s.getState().drag).toBeNull();
    expect(Object.keys(s.getDoc().bones)).toHaveLength(countDuringDrag + 1);
    expect(s.getDoc().bones[newId]).toBeDefined();
    // 再松手（此时已无会话，不应抛错或回滚）
    s.endDrag();
    expect(Object.keys(s.getDoc().bones)).toHaveLength(countDuringDrag + 1);
    // 撤销先撤新增骨骼，而不是拖动
    s.undo();
    expect(Object.keys(s.getDoc().bones)).toHaveLength(countDuringDrag);
  });

  it('结构编辑与姿态编辑在同一条历史线上交错撤销', () => {
    const s = createEditorStore();
    const count0 = Object.keys(s.getDoc().bones).length;
    s.seek(0);
    const root = s.getDoc().rootId!;
    const newId = s.addChildBone(root)!; // 结构
    expect(Object.keys(s.getDoc().bones)).toHaveLength(count0 + 1);
    const [, arm, fore] = Object.keys(s.getDoc().bones).filter((id) => id !== newId);
    s.beginDrag(fore);
    s.updateDrag({ x: 900, y: 300 });
    s.endDrag(); // 姿态
    s.undo(); // 撤姿态
    expect(Object.keys(s.getDoc().bones)).toHaveLength(count0 + 1);
    s.undo(); // 撤结构
    expect(Object.keys(s.getDoc().bones)).toHaveLength(count0);
  });
});
