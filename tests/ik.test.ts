import { describe, expect, it } from 'vitest';
import { solveTwoBoneIK } from '../src/core/ik';
import { dist } from '../src/core/math2d';

const shoulder = { x: 0, y: 0 };
const l1 = 40;
const l2 = 30;
const FREE = { parentMin: -Math.PI, parentMax: Math.PI, childMin: -Math.PI, childMax: Math.PI };

function endEffector(parentLocal: number, childLocal: number, g = 0) {
  const pw = g + parentLocal;
  const elbow = { x: Math.cos(pw) * l1, y: Math.sin(pw) * l1 };
  const cw = pw + childLocal;
  return { x: elbow.x + Math.cos(cw) * l2, y: elbow.y + Math.sin(cw) * l2 };
}

describe('两节骨逆向运动学 — 可达目标', () => {
  it('目标在正前方 50：末端精确到达', () => {
    const target = { x: 50, y: 0 };
    const r = solveTwoBoneIK(shoulder, l1, l2, target, { ...FREE, grandparentWorldAngle: 0, preferredBend: 1 });
    expect(r.clamped).toBe(false);
    const ee = endEffector(r.parentAngle, r.childAngle);
    expect(dist(ee, target)).toBeLessThan(1e-8);
  });

  it('任意可达点（20, 35）：误差为 0', () => {
    const target = { x: 20, y: 35 };
    const r = solveTwoBoneIK(shoulder, l1, l2, target, { ...FREE, grandparentWorldAngle: 0, preferredBend: 1 });
    expect(r.clamped).toBe(false);
    const ee = endEffector(r.parentAngle, r.childAngle);
    expect(dist(ee, target)).toBeLessThan(1e-8);
  });

  it('最大伸展 70 可达且不判为越界', () => {
    const target = { x: 70, y: 0 };
    const r = solveTwoBoneIK(shoulder, l1, l2, target, { ...FREE, grandparentWorldAngle: 0, preferredBend: 1 });
    expect(r.clamped).toBe(false);
    const ee = endEffector(r.parentAngle, r.childAngle);
    expect(dist(ee, target)).toBeLessThan(1e-8);
    // 方向角约定：完全伸直时子局部角为 0（与父同向）
    expect(Math.abs(r.childAngle)).toBeCloseTo(0, 9);
  });
});

describe('两节骨逆向运动学 — 不可达目标贴边界', () => {
  it('目标远超 l1+l2：clamped=true，末端贴在外包络（距离 70）', () => {
    const target = { x: 200, y: 0 };
    const r = solveTwoBoneIK(shoulder, l1, l2, target, { ...FREE, grandparentWorldAngle: 0, preferredBend: 1 });
    expect(r.clamped).toBe(true);
    const ee = endEffector(r.parentAngle, r.childAngle);
    expect(dist(ee, shoulder)).toBeCloseTo(70, 9);
    // 沿目标方向贴边
    expect(ee.x).toBeCloseTo(70);
    expect(ee.y).toBeCloseTo(0);
  });

  it('斜向远方 (100,100)：贴在 45° 方向的包络上', () => {
    const target = { x: 100, y: 100 };
    const r = solveTwoBoneIK(shoulder, l1, l2, target, { ...FREE, grandparentWorldAngle: 0, preferredBend: 1 });
    expect(r.clamped).toBe(true);
    const ee = endEffector(r.parentAngle, r.childAngle);
    expect(dist(ee, shoulder)).toBeCloseTo(70, 9);
    expect(Math.atan2(ee.y, ee.x)).toBeCloseTo(Math.PI / 4, 9);
  });

  it('目标比 |l1-l2|=10 更近：同样不可达，贴到内包络', () => {
    const target = { x: 5, y: 0 };
    const r = solveTwoBoneIK(shoulder, l1, l2, target, { ...FREE, grandparentWorldAngle: 0, preferredBend: 1 });
    expect(r.clamped).toBe(true);
    const ee = endEffector(r.parentAngle, r.childAngle);
    expect(dist(ee, shoulder)).toBeCloseTo(10, 9);
  });

  it('等长骨链（l1=l2）目标在肩关节处：折叠构型可达，末端落在肩上', () => {
    const r = solveTwoBoneIK(shoulder, 50, 50, { x: 0, y: 0 }, { ...FREE, grandparentWorldAngle: 0, preferredBend: 1 });
    const ee = endEffector50(r.parentAngle, r.childAngle);
    expect(dist(ee, shoulder)).toBeCloseTo(0, 9);
  });
});

function endEffector50(p: number, c: number) {
  const elbow = { x: Math.cos(p) * 50, y: Math.sin(p) * 50 };
  const cw = p + c;
  return { x: elbow.x + Math.cos(cw) * 50, y: elbow.y + Math.sin(cw) * 50 };
}

describe('两节骨逆向运动学 — 关节角度约束', () => {
  it('子关节限位 [-0.3, 0.3]：结果不越界，误差取约束下最小', () => {
    const target = { x: 20, y: 35 };
    const r = solveTwoBoneIK(shoulder, l1, l2, target, {
      parentMin: -Math.PI,
      parentMax: Math.PI,
      childMin: -0.3,
      childMax: 0.3,
      grandparentWorldAngle: 0,
      preferredBend: 1,
    });
    expect(r.childAngle).toBeGreaterThanOrEqual(-0.3 - 1e-9);
    expect(r.childAngle).toBeLessThanOrEqual(0.3 + 1e-9);
    const ee = endEffector(r.parentAngle, r.childAngle);
    // 盒内最优：子角必须贴边界 0.3（解析解的子角约 1.19 被夹）
    expect(Math.abs(r.childAngle - 0.3)).toBeLessThan(1e-6);
    // 误差显著小于「完全不动」或随意构型
    expect(dist(ee, target)).toBeLessThan(40);
  });

  it('父关节限位 [0, 0]（锁死朝 +X）：父局部角为 0', () => {
    const target = { x: 0, y: 50 };
    const r = solveTwoBoneIK(shoulder, l1, l2, target, {
      parentMin: 0,
      parentMax: 0,
      childMin: -Math.PI,
      childMax: Math.PI,
      grandparentWorldAngle: 0,
      preferredBend: 1,
    });
    expect(r.parentAngle).toBeCloseTo(0, 9);
    const ee = endEffector(r.parentAngle, r.childAngle);
    // 父锁死后，肘在 (40,0)，子去够 (0,50)
    expect(ee.x).toBeCloseTo(40 + 30 * Math.cos(r.childAngle), 9);
  });

  it('两关节都夹紧：解永远在限位盒内', () => {
    const target = { x: -100, y: -100 };
    const r = solveTwoBoneIK(shoulder, l1, l2, target, {
      parentMin: -0.5,
      parentMax: 0.5,
      childMin: -1.2,
      childMax: 0,
      grandparentWorldAngle: 0,
      preferredBend: 1,
    });
    expect(r.parentAngle).toBeGreaterThanOrEqual(-0.5 - 1e-9);
    expect(r.parentAngle).toBeLessThanOrEqual(0.5 + 1e-9);
    expect(r.childAngle).toBeGreaterThanOrEqual(-1.2 - 1e-9);
    expect(r.childAngle).toBeLessThanOrEqual(0 + 1e-9);
  });

  it('祖父世界方向为 90° 时，父局部角相对祖父计', () => {
    const target = { x: 0, y: 70 }; // 世界正下方，相对祖父(90°)方向是局部 0
    const r = solveTwoBoneIK(shoulder, l1, l2, target, {
      ...FREE,
      grandparentWorldAngle: Math.PI / 2,
      preferredBend: 1,
    });
    expect(r.clamped).toBe(false);
    const ee = endEffector(r.parentAngle, r.childAngle, Math.PI / 2);
    expect(dist(ee, target)).toBeLessThan(1e-8);
    expect(Math.abs(r.parentAngle)).toBeCloseTo(0, 6);
  });
});
