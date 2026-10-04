import type { SkeletonDocument } from './types';
import { boneCount, MAX_BONES, MIN_BONES } from './skeleton';

export interface ValidationIssue {
  level: 'error' | 'warning';
  code: string;
  message: string;
}

/**
 * 文档完整性检查。结构编辑的不变量：
 * 1. 单根、父子构成一棵树，无环
 * 2. 所有 parentId 引用都存在
 * 3. 不允许任何轨道引用已删除骨骼
 * 4. 关节限位区间合法
 * 5. 关键帧时间落在 [0, duration] 且轨道有序
 * 6. 骨骼数量在 2~15
 */
export function validateDocument(doc: SkeletonDocument): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const bones = Object.values(doc.bones);
  const ids = new Set(bones.map((b) => b.id));

  const count = boneCount(doc);
  if (count < MIN_BONES) {
    issues.push({
      level: 'warning',
      code: 'too-few-bones',
      message: `当前只有 ${count} 根骨骼，至少需要 ${MIN_BONES} 根（两节骨链）才能使用逆向定位`,
    });
  }
  if (count > MAX_BONES) {
    issues.push({
      level: 'error',
      code: 'too-many-bones',
      message: `骨骼数量 ${count} 超过上限 ${MAX_BONES}`,
    });
  }

  // 根检查
  const roots = bones.filter((b) => b.parentId === null);
  if (roots.length === 0) {
    issues.push({ level: 'error', code: 'no-root', message: '骨架没有根骨骼' });
  } else if (roots.length > 1) {
    issues.push({ level: 'error', code: 'multiple-roots', message: `存在 ${roots.length} 个根，骨骼必须构成单根父子树` });
  }
  if (doc.rootId !== null && !ids.has(doc.rootId)) {
    issues.push({ level: 'error', code: 'dangling-root', message: 'rootId 引用了不存在的骨骼' });
  }

  // 引用与环
  for (const b of bones) {
    if (b.parentId !== null && !ids.has(b.parentId)) {
      issues.push({ level: 'error', code: 'dangling-parent', message: `骨骼 ${b.name} 的父节点已不存在` });
    }
    // 沿父链走，重复访问即有环
    const seen = new Set<string>();
    let cursor: string | null = b.id;
    while (cursor !== null) {
      if (seen.has(cursor)) {
        issues.push({ level: 'error', code: 'cycle', message: `父子关系中存在环（涉及骨骼 ${b.name}）` });
        break;
      }
      seen.add(cursor);
      cursor = doc.bones[cursor]?.parentId ?? null;
    }
    if (!(b.maxAngle >= b.minAngle)) {
      issues.push({ level: 'error', code: 'bad-limit', message: `骨骼 ${b.name} 的角度限位区间非法（min > max）` });
    }
    if (b.length <= 0) {
      issues.push({ level: 'error', code: 'bad-length', message: `骨骼 ${b.name} 长度必须为正` });
    }
  }

  // 轨道：引用、时间范围、有序
  for (const [boneId, frames] of Object.entries(doc.tracks)) {
    if (!ids.has(boneId)) {
      issues.push({ level: 'error', code: 'orphan-track', message: `存在引用已删除骨骼的关键帧轨道（${boneId}）` });
    }
    let prev = -Infinity;
    const times = new Set<number>();
    for (const kf of frames) {
      if (kf.time < 0 || kf.time > doc.duration + 1e-9) {
        issues.push({ level: 'warning', code: 'kf-out-of-range', message: `骨骼 ${boneId} 存在时间范围外的关键帧 ${kf.time.toFixed(2)}s` });
      }
      if (kf.time < prev - 1e-9) {
        issues.push({ level: 'error', code: 'kf-unsorted', message: `骨骼 ${boneId} 的关键帧未按时间排序` });
      }
      prev = kf.time;
      if (times.has(kf.time)) {
        issues.push({ level: 'error', code: 'kf-duplicate', message: `骨骼 ${boneId} 在 ${kf.time}s 有重复关键帧` });
      }
      times.add(kf.time);
      if (kf.length <= 0) {
        issues.push({ level: 'error', code: 'kf-bad-length', message: `骨骼 ${boneId} 关键帧长度必须为正` });
      }
    }
  }

  return issues;
}

export const hasErrors = (issues: ValidationIssue[]): boolean =>
  issues.some((i) => i.level === 'error');
