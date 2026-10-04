import type { Bone, IKResult, SkeletonDocument, Vec2, WorldBone, WorldPose } from './types';
import { normalizeAngle } from './math2d';

export interface TwoBoneChain {
  parent: WorldBone;
  child: WorldBone;
  /** 父骨骼的父节点世界方向角；父为根时取根的世界偏移（通常 0） */
  grandparentWorldAngle: number;
  parentBone: Bone;
  childBone: Bone;
}

/**
 * 从世界姿态中取出「父 -> 末端子」两节骨链。
 * 返回 null 表示该骨骼没有父节点，无法构成两节链。
 */
export function getTwoBoneChain(
  doc: SkeletonDocument,
  pose: WorldPose,
  childId: string,
  rootWorldOffset = 0
): TwoBoneChain | null {
  const child = pose.find((w) => w.id === childId);
  if (!child || child.parentId === null) return null;
  const parent = pose.find((w) => w.id === child.parentId);
  if (!parent) return null;
  const parentBone = doc.bones[parent.id];
  const childBone = doc.bones[child.id];
  if (!parentBone || !childBone) return null;
  const grand =
    parent.parentId !== null
      ? pose.find((w) => w.id === parent.parentId)
      : undefined;
  return {
    parent,
    child,
    grandparentWorldAngle: grand ? grand.worldAngle : rootWorldOffset,
    parentBone,
    childBone,
  };
}

export interface SolveTwoBoneOptions {
  parentMin: number;
  parentMax: number;
  childMin: number;
  childMax: number;
  /** 祖父世界方向角，父为根时给世界偏移 */
  grandparentWorldAngle: number;
  /** 期望的弯折方向符号：+1 / -1，用于二选一时保持当前弯折侧 */
  preferredBend: 1 | -1;
}

interface Candidate {
  parentLocal: number;
  childLocal: number;
  error: number;
}

/**
 * 两节骨链解析逆向运动学。
 *
 * @param shoulder 父骨骼起点（肩关节）
 * @param l1 父骨骼长度
 * @param l2 子骨骼长度
 * @param target 末端目标点
 * @returns 父/子的局部角度；目标超出可达范围时末端贴在 l1+l2 包络边界上，
 *          clamped=true；距离小于 |l1-l2| 时同样视为不可达。
 *
 * 关节限位：在肘上/肘下两组解析解之外，加入「只夹父关节」「只夹子关节」
 * 的盒投影候选，统一按末端到目标的距离打分取最优。
 */
export function solveTwoBoneIK(
  shoulder: Vec2,
  l1: number,
  l2: number,
  target: Vec2,
  opts: SolveTwoBoneOptions
): IKResult {
  const dx = target.x - shoulder.x;
  const dy = target.y - shoulder.y;
  const rawDist = Math.hypot(dx, dy);
  const maxReach = l1 + l2;
  const minReach = Math.abs(l1 - l2);

  const tooFar = rawDist > maxReach + 1e-9;
  const tooClose = rawDist < minReach - 1e-9;
  const clamped = tooFar || tooClose;
  // 不可达时把目标沿肩->目标方向贴到可达包络边界
  const d = Math.min(maxReach, Math.max(minReach, rawDist));
  const phi = Math.atan2(dy, dx);

  // 余弦定理：膝处世界方向相对父方向的偏转角 a2，
  // 肩关节相对「肩->目标」连线的偏移 a1。
  // 注意：局部角在正运动学中是「方向角」而非「转折角」，
  // 因此子局部角直接为 ±a2（不是 ±(π-a2)）。
  const cosA2 = (d * d - l1 * l1 - l2 * l2) / (2 * l1 * l2);
  const a2 = Math.acos(Math.min(1, Math.max(-1, cosA2)));
  const a1 = Math.atan2(l2 * Math.sin(a2), l1 + l2 * Math.cos(a2));
  const g = opts.grandparentWorldAngle;

  // 两组解析解：(父世界角, 子局部角)
  const branches: Array<{ pw: number; childLocal: number }> = [
    { pw: phi - a1, childLocal: a2 },
    { pw: phi + a1, childLocal: -a2 },
  ];

  // 所有候选都经过统一的限位盒投影，因此返回值永远不越界。
  // 候选集合：
  //  A. 两个解析分支（各自夹到限位盒内）
  //  B. 子关节固定在 min/max 边界时，解析反解父世界角（两种弯折）
  //  C. 父关节固定在 min/max 边界时，解析反解子局部角
  // 统一按末端误差打分，得到盒内最优可行近似。
  const candidates: Candidate[] = [];

  // A. 解析分支
  for (const br of branches) {
    addCandidate(shoulder, l1, l2, g, br.pw, br.childLocal, target, opts, candidates);
  }

  // B. 子角固定在边界：ee = shoulder + l1 u(pw) + l2 u(pw + c)
  //    令 v = u(c)，则 ee = shoulder + R(pw)·(l1 + l2 v)。
  //    向量 L = (l1 + l2 cos c, l2 sin c) 长度 |L|、方向 β，
  //    故 pw = φ_target - β（±同解），先以未夹取的世界角入列，再统一夹取。
  for (const cFixed of [opts.childMin, opts.childMax]) {
    if (!Number.isFinite(cFixed)) continue;
    const lx = l1 + l2 * Math.cos(cFixed);
    const ly = l2 * Math.sin(cFixed);
    const beta = Math.atan2(ly, lx);
    addCandidate(shoulder, l1, l2, g, phi - beta, cFixed, target, opts, candidates);
    addCandidate(shoulder, l1, l2, g, phi - beta + 2 * Math.PI, cFixed, target, opts, candidates);
  }

  // C. 父角固定在边界：肘固定，子骨骼去够目标，
  //    子局部角 = atan2(target - elbow) - pw（再夹子限位）
  for (const pFixed of [opts.parentMin, opts.parentMax]) {
    if (!Number.isFinite(pFixed)) continue;
    const pw = g + pFixed;
    const elbow = {
      x: shoulder.x + Math.cos(pw) * l1,
      y: shoulder.y + Math.sin(pw) * l1,
    };
    const childRaw = Math.atan2(target.y - elbow.y, target.x - elbow.x) - pw;
    addCandidate(shoulder, l1, l2, g, pw, childRaw, target, opts, candidates);
  }

  const best = pickBest(candidates, opts.preferredBend);
  return {
    parentAngle: best.parentLocal,
    childAngle: best.childLocal,
    clamped,
  };
}

/**
 * 把局部角夹到限位。限位均以弧度表示且约定在 [-π, π] 内，
 * 直接夹取即可；FREE（±Infinity）时原样返回。
 */
function clampLocal(raw: number, min: number, max: number): number {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return raw;
  return Math.min(max, Math.max(min, raw));
}

/** 由「父世界角 + 子局部角」施加限位并正算末端，记录到目标的误差 */
function addCandidate(
  shoulder: Vec2,
  l1: number,
  l2: number,
  g: number,
  parentWorldRaw: number,
  childLocalRaw: number,
  target: Vec2,
  opts: SolveTwoBoneOptions,
  out: Candidate[]
): void {
  const parentLocal = clampLocal(parentWorldRaw - g, opts.parentMin, opts.parentMax);
  const childLocal = clampLocal(childLocalRaw, opts.childMin, opts.childMax);
  const pw = g + parentLocal;
  const eeX = shoulder.x + Math.cos(pw) * l1 + Math.cos(pw + childLocal) * l2;
  const eeY = shoulder.y + Math.sin(pw) * l1 + Math.sin(pw + childLocal) * l2;
  out.push({
    parentLocal,
    childLocal,
    error: Math.hypot(eeX - target.x, eeY - target.y),
  });
}

/**
 * 候选打分：误差最小者胜。误差并列时：
 * 1. 优先偏好的弯折侧（sin 符号，对 ±π 折叠/伸展同样可区分构型）
 * 2. 同侧时优先角度改动小
 */
function pickBest(candidates: Candidate[], preferredBend: 1 | -1): Candidate {
  // 用 sin(childLocal) 的符号区分构型：+ 为肘上，- 为肘下；
  // ±π 时 sin≈0，视为「伸直」中性构型，不据此偏向任一侧
  const bendSign = (c: Candidate): number => {
    const s = Math.sin(c.childLocal);
    if (s > 1e-6) return 1;
    if (s < -1e-6) return -1;
    return 0;
  };
  return candidates.reduce((acc, c) => {
    if (c.error < acc.error - 1e-9) return c;
    if (c.error > acc.error + 1e-9) return acc;
    const sb = bendSign(c);
    const sa = bendSign(acc);
    if (sb === preferredBend && sa !== preferredBend) return c;
    if (sa === preferredBend && sb !== preferredBend) return acc;
    return Math.abs(c.childLocal) + Math.abs(c.parentLocal) <
      Math.abs(acc.childLocal) + Math.abs(acc.parentLocal)
      ? c
      : acc;
  });
}
