import type { Keyframe, SkeletonDocument, Vec2 } from './types';
import { canReparent, childMap, evaluatePose, findWorldBone, sampleTrack } from './skeleton';
import { dist, normalizeAngle } from './math2d';
import { hasErrors, validateDocument } from './validation';

const EPS = 1e-9;

export interface KeepPoseReparentOptions {
  time: number;
  rootPosition: Vec2;
  rootWorldOffset?: number;
}

export type KeepPoseReparentResult =
  | { ok: true; doc: SkeletonDocument }
  | { ok: false; code: KeepPoseReparentErrorCode; message: string };

export type KeepPoseReparentErrorCode =
  | 'invalid-document'
  | 'invalid-time'
  | 'bone-not-found'
  | 'new-parent-not-found'
  | 'cannot-reparent-root'
  | 'invalid-parent'
  | 'zero-length'
  | 'joint-limit'
  | 'pose-not-preserved';

/**
 * 在当前帧保持世界姿态地修改父骨骼。
 *
 * 被移动骨骼的起点会变为新父末端，但其旧末端保持不变，因此：
 * - 新长度 = 新父末端到旧末端的距离；
 * - 新世界方向由该向量决定，再换算为相对新父的局部角；
 * - 直接子骨的世界方向不变，所以要补上“被移动骨新世界方向”的变化；
 * - 更深后代的局部角不变。
 *
 * 该函数只在 time 处为被移动骨及其直接子骨写关键帧；其它时刻仍按原轨道插值。
 * 被移动骨自身的世界方向由新父末端指向旧末端的向量决定；直接子骨及更深后代的
 * 世界方向保持不变。任一前置条件或结果校验失败时返回错误，不修改传入文档。
 */
export function reparentKeepPose(
  doc: SkeletonDocument,
  boneId: string,
  newParentId: string | null,
  opts: KeepPoseReparentOptions
): KeepPoseReparentResult {
  const fail = (code: KeepPoseReparentErrorCode, message: string): KeepPoseReparentResult => ({
    ok: false,
    code,
    message,
  });

  if (hasErrors(validateDocument(doc))) {
    return fail('invalid-document', '文档当前存在校验错误，不能执行保持姿态改父');
  }
  if (!Number.isFinite(opts.time) || opts.time < -EPS || opts.time > doc.duration + EPS) {
    return fail('invalid-time', '当前时间不在动画时间范围内');
  }

  const bone = doc.bones[boneId];
  if (!bone) return fail('bone-not-found', '被移动的骨骼不存在');
  if (bone.parentId === null) {
    return fail('cannot-reparent-root', '单根骨架的根骨骼不能改挂到其他骨骼下');
  }
  if (newParentId === null) {
    return fail('new-parent-not-found', '保持姿态改父必须指定一个已存在的新父骨骼');
  }
  const newParent = doc.bones[newParentId];
  if (!newParent) return fail('new-parent-not-found', '新父骨骼不存在');
  if (!canReparent(doc.bones, boneId, newParentId)) {
    return fail('invalid-parent', '新父不能是被移动骨骼自身或其后代');
  }

  const time = Math.min(doc.duration, Math.max(0, opts.time));
  const poseOptions = {
    rootPosition: opts.rootPosition,
    rootWorldOffset: opts.rootWorldOffset ?? 0,
  };
  const oldPose = evaluatePose(doc, time, poseOptions);
  const movedOld = findWorldBone(oldPose, boneId);
  const newParentPose = findWorldBone(oldPose, newParentId);
  if (!movedOld || !newParentPose) {
    return fail('invalid-document', '当前文档无法完整求解世界姿态');
  }
  for (const wb of oldPose) {
    const sampledBone = doc.bones[wb.id];
    const sampled = sampleTrack(doc.tracks[wb.id], time, {
      angle: sampledBone.angle,
      length: sampledBone.length,
    });
    if (!angleWithinLimit(sampled.angle, sampledBone)) {
      return fail('invalid-document', `骨骼「${sampledBone.name}」的当前帧角度已越过关节限位`);
    }
    if (!(sampled.length > EPS)) {
      return fail('invalid-document', `骨骼「${sampledBone.name}」的当前帧长度非正`);
    }
  }

  const newStart = newParentPose.end;
  const newLength = dist(newStart, movedOld.end);
  if (!Number.isFinite(newLength) || newLength <= EPS) {
    return fail('zero-length', '新父末端与被移动骨骼末端重合，所需新骨长为零');
  }

  const newWorldAngle = Math.atan2(
    movedOld.end.y - newStart.y,
    movedOld.end.x - newStart.x
  );
  const newLocalAngle = normalizeAngle(newWorldAngle - newParentPose.worldAngle);
  if (!angleWithinLimit(newLocalAngle, bone)) {
    return fail(
      'joint-limit',
      `骨骼「${bone.name}」的新局部角 ${newLocalAngle} 越过关节限位`
    );
  }

  const children = childMap(doc.bones).get(boneId) ?? [];
  const childAngles = new Map<string, number>();
  for (const childId of children) {
    const childBone = doc.bones[childId];
    const childPose = findWorldBone(oldPose, childId);
    if (!childBone || !childPose) {
      return fail('invalid-document', `直接子骨「${childId}」无法求解世界姿态`);
    }
    const newChildAngle = normalizeAngle(childPose.worldAngle - newWorldAngle);
    if (!angleWithinLimit(newChildAngle, childBone)) {
      return fail(
        'joint-limit',
        `直接子骨「${childBone.name}」补偿后的局部角越过关节限位`
      );
    }
    childAngles.set(childId, newChildAngle);
  }

  // 先在克隆上完成整笔结构与轨道修改；任何后续失败都不会触碰原文档。
  const next: SkeletonDocument = structuredClone(doc);
  next.bones[boneId] = { ...next.bones[boneId], parentId: newParentId };
  next.tracks[boneId] = putKeyframe(next.tracks[boneId] ?? [], {
    time,
    angle: newLocalAngle,
    length: newLength,
  });
  for (const childId of children) {
    const childPose = findWorldBone(oldPose, childId)!;
    next.tracks[childId] = putKeyframe(next.tracks[childId] ?? [], {
      time,
      angle: childAngles.get(childId)!,
      length: childPose.length,
    });
  }

  if (hasErrors(validateDocument(next))) {
    return fail('invalid-document', '改父后的文档未通过完整性校验');
  }

  const newPose = evaluatePose(next, time, poseOptions);
  const movedNew = findWorldBone(newPose, boneId);
  if (!movedNew || dist(movedNew.end, movedOld.end) > 1e-6) {
    return fail('pose-not-preserved', '未能保持被移动骨骼的当前帧末端');
  }

  const descendantIds = collectDescendants(doc.bones, boneId);
  for (const id of descendantIds) {
    const before = findWorldBone(oldPose, id);
    const after = findWorldBone(newPose, id);
    if (!before || !after) {
      return fail('pose-not-preserved', `后代骨骼「${id}」的当前帧姿态丢失`);
    }
    if (dist(after.end, before.end) > 1e-6 || angleDistance(after.worldAngle, before.worldAngle) > 1e-6) {
      return fail('pose-not-preserved', `后代骨骼「${id}」的当前帧世界端点或方向发生变化`);
    }
  }

  return { ok: true, doc: next };
}

function putKeyframe(track: Keyframe[] | undefined, keyframe: Keyframe): Keyframe[] {
  return [...(track ?? []).filter((k) => k.time !== keyframe.time), { ...keyframe }].sort(
    (a, b) => a.time - b.time
  );
}

function angleWithinLimit(angle: number, bone: { minAngle: number; maxAngle: number }): boolean {
  return Number.isFinite(angle) && angle >= bone.minAngle - EPS && angle <= bone.maxAngle + EPS;
}

function angleDistance(a: number, b: number): number {
  return Math.abs(normalizeAngle(a - b));
}

function collectDescendants(
  bones: SkeletonDocument['bones'],
  ancestorId: string
): string[] {
  const result: string[] = [];
  const childrenById = childMap(bones);
  const stack = [...(childrenById.get(ancestorId) ?? [])];
  while (stack.length > 0) {
    const id = stack.pop()!;
    result.push(id);
    stack.push(...(childrenById.get(id) ?? []));
  }
  return result;
}
