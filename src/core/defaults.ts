import type { SkeletonDocument } from './types';
import { createBone } from './skeleton';

/**
 * 默认骨架：一条 4 骨骼链（肩 -> 上臂 -> 前臂 -> 手），
 * 关节带角度限位，时长 2s 且每根骨骼在 0/1/2s 有关键帧。
 */
export function createDefaultDocument(): SkeletonDocument {
  const hip = createBone({ name: '躯干', parentId: null, angle: -Math.PI / 2, length: 70 });
  const arm = createBone({
    name: '上臂',
    parentId: hip.id,
    angle: 0.5,
    length: 60,
    minAngle: -2.4,
    maxAngle: 2.4,
  });
  const fore = createBone({
    name: '前臂',
    parentId: arm.id,
    angle: -0.9,
    length: 55,
    minAngle: -2.6,
    maxAngle: 0.2,
  });
  const hand = createBone({
    name: '手',
    parentId: fore.id,
    angle: -0.3,
    length: 28,
    minAngle: -1.2,
    maxAngle: 1.2,
  });

  const bones = Object.fromEntries([hip, arm, fore, hand].map((b) => [b.id, b]));
  const kf = (time: number, angle: number, length: number) => ({ time, angle, length });

  const tracks = {
    [hip.id]: [kf(0, -Math.PI / 2, 70), kf(1, -Math.PI / 2 - 0.25, 70), kf(2, -Math.PI / 2, 70)],
    [arm.id]: [kf(0, 0.5, 60), kf(1, 1.1, 60), kf(2, 0.5, 60)],
    [fore.id]: [kf(0, -0.9, 55), kf(1, -0.4, 55), kf(2, -0.9, 55)],
    [hand.id]: [kf(0, -0.3, 28), kf(1, 0.3, 28), kf(2, -0.3, 28)],
  };

  return { bones, rootId: hip.id, tracks, duration: 2 };
}
