import { describe, expect, it } from 'vitest';
import { evaluatePose, orderedBoneIds, createBone } from '../src/core/skeleton';
import type { SkeletonDocument } from '../src/core/types';
import { fromAngle, normalizeAngle, lerpAngle } from '../src/core/math2d';

function doc(): SkeletonDocument {
  // 根 + 两子的简单树，根位于 (100, 100)
  const a = createBone({ name: 'a', parentId: null, angle: 0, length: 100 });
  const b = createBone({ name: 'b', parentId: a.id, angle: Math.PI / 2, length: 50 });
  const c = createBone({ name: 'c', parentId: a.id, angle: -Math.PI / 2, length: 25 });
  return {
    bones: Object.fromEntries([a, b, c].map((x) => [x.id, x])),
    rootId: a.id,
    tracks: {},
    duration: 1,
  };
}

describe('坐标变换 / 前向运动学', () => {
  it('局部角 0 的子骨骼沿父方向延伸', () => {
    const d = doc();
    const pose = evaluatePose(d, 0, { rootPosition: { x: 100, y: 100 } });
    const a = pose.find((w) => w.id === d.rootId)!;
    expect(a.start).toEqual({ x: 100, y: 100 });
    expect(a.end.x).toBeCloseTo(200);
    expect(a.end.y).toBeCloseTo(100);
  });

  it('局部角 π/2 的子骨骼世界方向为 90°，末端在父终点正下方（屏幕坐标 y 向下）', () => {
    const d = doc();
    const pose = evaluatePose(d, 0, { rootPosition: { x: 100, y: 100 } });
    const a = pose.find((w) => d.bones[Object.keys(d.bones)[1]].id === w.id)!;
    expect(a.start.x).toBeCloseTo(200);
    expect(a.start.y).toBeCloseTo(100);
    expect(a.end.x).toBeCloseTo(200);
    expect(a.end.y).toBeCloseTo(150);
    expect(a.worldAngle).toBeCloseTo(Math.PI / 2);
    expect(a.localAngle).toBeCloseTo(Math.PI / 2);
  });

  it('局部角 -π/2 的分支向上', () => {
    const d = doc();
    const pose = evaluatePose(d, 0, { rootPosition: { x: 100, y: 100 } });
    const c = pose.find((w) => w.parentId === d.rootId && w.length === 25)!;
    expect(c.end.x).toBeCloseTo(200);
    expect(c.end.y).toBeCloseTo(75);
  });

  it('多级旋转累加：祖父 90° + 父 90° => 子世界 180°', () => {
    const g = createBone({ name: 'g', parentId: null, angle: Math.PI / 2, length: 10 });
    const p = createBone({ name: 'p', parentId: g.id, angle: Math.PI / 2, length: 10 });
    const s = createBone({ name: 's', parentId: p.id, angle: 0, length: 10 });
    const d: SkeletonDocument = {
      bones: Object.fromEntries([g, p, s].map((x) => [x.id, x])),
      rootId: g.id,
      tracks: {},
      duration: 1,
    };
    const pose = evaluatePose(d, 0, { rootPosition: { x: 0, y: 0 } });
    expect(pose[2].worldAngle).toBeCloseTo(Math.PI);
    // g 末端 (0,10)；p 世界角 π -> (-10,10)；s 世界角 π -> (-20,10)
    expect(pose[2].end.x).toBeCloseTo(-20);
    expect(pose[2].end.y).toBeCloseTo(10);
  });

  it('从根到叶排序，父总在子之前', () => {
    const d = doc();
    const order = orderedBoneIds(d);
    const idx = new Map<string, number>(order.map((id, i) => [id, i]));
    for (const b of Object.values(d.bones)) {
      if (b.parentId) expect(idx.get(b.id)! > idx.get(b.parentId)!).toBe(true);
    }
  });

  it('fromAngle 与归一化角度', () => {
    expect(fromAngle(0, 10)).toEqual({ x: 10, y: 0 });
    // 3π 归一化到 [-π,π)：3π-2π=π，π 端点归属 -π
    expect(normalizeAngle(3 * Math.PI)).toBeCloseTo(-Math.PI, 9);
    expect(normalizeAngle(-3 * Math.PI)).toBeCloseTo(-Math.PI, 9);
    expect(normalizeAngle(Math.PI / 2 + 2 * Math.PI)).toBeCloseTo(Math.PI / 2, 9);
  });

  it('角度插值走最短弧：170° -> -170° 在中点应经过 180° 而非 0°', () => {
    const mid = lerpAngle((170 * Math.PI) / 180, (-170 * Math.PI) / 180, 0.5);
    expect(Math.abs(normalizeAngle(mid))).toBeCloseTo(Math.PI, 9);
  });
});
