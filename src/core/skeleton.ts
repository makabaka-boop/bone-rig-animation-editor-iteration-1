import type {
  Bone,
  Keyframe,
  SkeletonDocument,
  Tracks,
  Vec2,
  WorldBone,
  WorldPose,
} from './types';
import { add, clampAngle, fromAngle, lerp, lerpAngle, normalizeAngle } from './math2d';

let idCounter = 0;
/** 生成在单次会话内唯一的骨骼 id（时间戳 + 计数器，避免连续创建撞号） */
export function nextBoneId(): string {
  idCounter += 1;
  return `bone_${Date.now().toString(36)}_${idCounter}`;
}

export function createBone(
  partial: Partial<Bone> & { parentId: string | null }
): Bone {
  return {
    id: nextBoneId(),
    name: partial.name ?? 'bone',
    parentId: partial.parentId,
    angle: partial.angle ?? 0,
    length: partial.length ?? 60,
    minAngle: partial.minAngle ?? -Math.PI,
    maxAngle: partial.maxAngle ?? Math.PI,
  };
}

/**
 * 校验候选父子关系是否合法。
 * 防止：自身挂自身、祖先挂到自己的后代（形成环）、引用不存在的骨骼。
 * 仅检查「若把 boneId 的父节点改成 newParentId」这一种变更。
 */
export function canReparent(
  bones: Record<string, Bone>,
  boneId: string,
  newParentId: string | null
): boolean {
  if (!bones[boneId]) return false;
  if (newParentId === null) return true; // 摘为根总是合法（仅当树允许多个根时）
  if (newParentId === boneId) return false;
  if (!bones[newParentId]) return false;
  // 若 newParentId 是 boneId 的后代，则形成环
  let cursor: string | null = newParentId;
  const guard = new Set<string>();
  while (cursor !== null) {
    if (cursor === boneId) return false;
    if (guard.has(cursor)) return false; // 既有数据已带环，防御性处理
    guard.add(cursor);
    cursor = bones[cursor]?.parentId ?? null;
  }
  return true;
}

/** 从根开始做拓扑排序；数据异常（环/断链）时跳过不可达节点 */
export function orderedBoneIds(doc: SkeletonDocument): string[] {
  const { bones, rootId } = doc;
  const order: string[] = [];
  if (rootId === null || !bones[rootId]) return order;
  const children = childMap(bones);
  const stack = [rootId];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    order.push(id);
    // 逆序压栈，使第一个子节点先出栈，保持创建顺序稳定
    const kids = children.get(id) ?? [];
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
  }
  return order;
}

export function childMap(bones: Record<string, Bone>): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const b of Object.values(bones)) {
    if (b.parentId !== null) {
      const list = map.get(b.parentId) ?? [];
      list.push(b.id);
      map.set(b.parentId, list);
    }
  }
  return map;
}

/** 深度：根为 0 */
export function depthOf(bones: Record<string, Bone>, id: string): number {
  let d = 0;
  let cursor: string | null = id;
  const guard = new Set<string>();
  while (cursor !== null && bones[cursor]) {
    if (guard.has(cursor)) break;
    guard.add(cursor);
    cursor = bones[cursor].parentId;
    d += 1;
  }
  return d - 1;
}

/**
 * 删除骨骼：
 * - 其子骨骼被一并删除（否则会出现悬挂引用）
 * - 所有被删骨骼的关键帧轨道一并删除（不允许留下引用已删除骨骼的帧）
 * 返回新文档（不可变更新）。
 */
export function deleteBoneCascade(
  doc: SkeletonDocument,
  boneId: string
): SkeletonDocument {
  const toDelete = new Set<string>();
  const collect = (id: string) => {
    toDelete.add(id);
    for (const b of Object.values(doc.bones)) {
      if (b.parentId === id && !toDelete.has(b.id)) collect(b.id);
    }
  };
  collect(boneId);

  const bones: Record<string, Bone> = {};
  for (const [id, b] of Object.entries(doc.bones)) {
    if (!toDelete.has(id)) bones[id] = b;
  }
  const tracks: Tracks = {};
  for (const [id, kfs] of Object.entries(doc.tracks)) {
    if (!toDelete.has(id)) tracks[id] = kfs.map((k) => ({ ...k }));
  }
  const rootId = toDelete.has(doc.rootId ?? '') ? null : doc.rootId;
  return { ...doc, bones, tracks, rootId };
}

/**
 * 删除一根骨骼但不删子树：子骨骼挂到被删骨骼的父节点下。
 * 角度换算为保持世界方向不变（localAngle += 被删者的 localAngle）。
 */
export function deleteBonePromoteChildren(
  doc: SkeletonDocument,
  boneId: string
): SkeletonDocument {
  const victim = doc.bones[boneId];
  if (!victim) return doc;
  const bones: Record<string, Bone> = {};
  for (const [id, b] of Object.entries(doc.bones)) {
    if (id === boneId) continue;
    if (b.parentId === boneId) {
      // 保持世界方向：新世界局部角 = 旧局部角 + 被删骨局部角
      bones[id] = { ...b, parentId: victim.parentId, angle: normalizeAngle(b.angle + victim.angle) };
    } else {
      bones[id] = { ...b };
    }
  }
  const tracks: Tracks = {};
  for (const [id, kfs] of Object.entries(doc.tracks)) {
    if (id === boneId) continue;
    if (doc.bones[id]?.parentId === boneId) {
      tracks[id] = kfs.map((k) => ({
        ...k,
        angle: normalizeAngle(k.angle + interpTrackAngle(doc.tracks[boneId] ?? [], k.time)),
      }));
    } else {
      tracks[id] = kfs.map((k) => ({ ...k }));
    }
  }
  const rootId = doc.rootId === boneId ? victim.parentId : doc.rootId;
  return { ...doc, bones, tracks, rootId };
}

/** 在已排序轨道上取某时刻的角度值（用于删骨时补偿子轨道） */
function interpTrackAngle(frames: Keyframe[], time: number): number {
  if (frames.length === 0) return 0;
  const sorted = [...frames].sort((a, b) => a.time - b.time);
  if (time <= sorted[0].time) return sorted[0].angle;
  const last = sorted[sorted.length - 1];
  if (time >= last.time) return last.angle;
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (time >= a.time && time <= b.time) {
      const t = (time - a.time) / (b.time - a.time);
      return lerpAngle(a.angle, b.angle, t);
    }
  }
  return last.angle;
}

/** 轨道不可变更新：写入/替换同一时刻的关键帧；同时做关节角限位 */
export function upsertKeyframe(
  track: Keyframe[],
  kf: Keyframe,
  bone?: Bone
): Keyframe[] {
  const angle = bone ? clampAngle(kf.angle, bone.minAngle, bone.maxAngle) : kf.angle;
  const next = track.filter((k) => k.time !== kf.time);
  next.push({ time: kf.time, angle, length: Math.max(1, kf.length) });
  return next.sort((a, b) => a.time - b.time);
}

/** 删除某骨骼轨道上指定时刻的关键帧 */
export function removeKeyframe(track: Keyframe[], time: number): Keyframe[] {
  return track.filter((k) => k.time !== time).map((k) => ({ ...k }));
}

/**
 * 对单条轨道在 time 处采样。
 * - 早于首帧：钳为首帧
 * - 晚于末帧：钳为末帧
 * - 两帧之间：角度走最短弧插值，长度线性插值
 * 空轨道回退到 rest 值。
 */
export function sampleTrack(
  track: Keyframe[] | undefined,
  time: number,
  rest: { angle: number; length: number }
): { angle: number; length: number } {
  if (!track || track.length === 0) return { ...rest };
  const sorted = track; // upsertKeyframe 已保证有序
  if (time <= sorted[0].time) return { angle: sorted[0].angle, length: sorted[0].length };
  const last = sorted[sorted.length - 1];
  if (time >= last.time) return { angle: last.angle, length: last.length };
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (time >= a.time && time <= b.time) {
      const t = (time - a.time) / (b.time - a.time);
      return {
        angle: lerpAngle(a.angle, b.angle, t),
        length: lerp(a.length, b.length, t),
      };
    }
  }
  return { angle: last.angle, length: last.length };
}

export interface PoseSampleOptions {
  /** 根骨骼在世界中的位置 */
  rootPosition?: Vec2;
  /** 整体世界旋转偏移（弧度），默认 0 */
  rootWorldOffset?: number;
}

/**
 * 前向运动学：在给定时间对所有轨道插值，再由根到叶求全局姿态。
 * 关键帧存的是局部角度与长度，播放时先插值再求世界变换。
 */
export function evaluatePose(
  doc: SkeletonDocument,
  time: number,
  opts: PoseSampleOptions = {}
): WorldPose {
  const rootPos = opts.rootPosition ?? { x: 200, y: 300 };
  const rootOffset = opts.rootWorldOffset ?? 0;
  const order = orderedBoneIds(doc);
  const pose: WorldPose = [];

  for (const id of order) {
    const bone = doc.bones[id];
    const { angle: localAngle, length } = sampleTrack(doc.tracks[id], time, {
      angle: bone.angle,
      length: bone.length,
    });
    // 插值结果也不能越过关节限位（两帧之间的弧线同样受约束）
    const clampedLocal = clampAngle(localAngle, bone.minAngle, bone.maxAngle);

    let start: Vec2;
    let worldAngle: number;
    if (bone.parentId === null) {
      start = rootPos;
      worldAngle = rootOffset + clampedLocal;
    } else {
      const parent = pose.find((w) => w.id === bone.parentId);
      if (!parent) continue; // 防御：断链骨不绘制
      start = parent.end;
      worldAngle = parent.worldAngle + clampedLocal;
    }
    const end = add(start, fromAngle(worldAngle, length));
    pose.push({
      id,
      parentId: bone.parentId,
      start,
      end,
      worldAngle,
      localAngle: clampedLocal,
      length,
    });
  }
  return pose;
}

/** 取世界姿态中某根骨骼 */
export function findWorldBone(pose: WorldPose, id: string): WorldBone | undefined {
  return pose.find((w) => w.id === id);
}

/** 文档内骨骼数量 */
export function boneCount(doc: SkeletonDocument): number {
  return Object.keys(doc.bones).length;
}

export const MAX_BONES = 15;
export const MIN_BONES = 2;
