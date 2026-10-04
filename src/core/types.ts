/** 二维向量 */
export interface Vec2 {
  x: number;
  y: number;
}

/**
 * 骨骼。角度与长度都是「局部」量：
 * - angle 为相对父骨骼方向的角度（根骨骼相对世界 +X 轴）
 * - length 为骨骼自身长度
 * - minAngle/maxAngle 为该骨骼局部角度允许的范围（弧度）
 */
export interface Bone {
  id: string;
  name: string;
  parentId: string | null;
  angle: number;
  length: number;
  minAngle: number;
  maxAngle: number;
}

/** 某根骨骼在某时刻的关键帧（局部量） */
export interface Keyframe {
  /** 时间，秒 */
  time: number;
  angle: number;
  length: number;
}

/** 每根骨骼一条关键帧轨道 */
export type Tracks = Record<string, Keyframe[]>;

/** 动画文档：骨骼树 + 轨道 + 播放时长 */
export interface SkeletonDocument {
  bones: Record<string, Bone>;
  rootId: string | null;
  tracks: Tracks;
  duration: number;
}

/** 单根骨骼的世界姿态 */
export interface WorldBone {
  id: string;
  parentId: string | null;
  /** 骨骼起点（世界坐标） */
  start: Vec2;
  /** 骨骼终点（世界坐标） */
  end: Vec2;
  /** 世界方向角（弧度） */
  worldAngle: number;
  /** 该时刻的局部角度 */
  localAngle: number;
  length: number;
}

/** 整棵树的世界姿态，按从根到叶排序 */
export type WorldPose = WorldBone[];

/** IK 解算对两节骨链产生的局部角度修正 */
export interface IKResult {
  /** 父骨骼局部角度（若无祖父则为世界角度） */
  parentAngle: number;
  /** 被拖动的子骨骼局部角度 */
  childAngle: number;
  /** true 表示目标超出可达距离，末端被贴到可达包络边界 */
  clamped: boolean;
}
