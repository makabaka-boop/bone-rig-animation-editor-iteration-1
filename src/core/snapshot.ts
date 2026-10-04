import type { SkeletonDocument, WorldPose } from './types';
import { evaluatePose } from './skeleton';
import { validateDocument, type ValidationIssue } from './validation';

/**
 * 修订快照：播放画面、单帧数值检查与导出共用同一份不可变数据，
 * 避免三处各自从可变 store 里取到不同版本。
 */
export interface RevisionSnapshot {
  rev: number;
  doc: Readonly<SkeletonDocument>;
  issues: ReadonlyArray<ValidationIssue>;
}

export function takeSnapshot(rev: number, doc: SkeletonDocument): RevisionSnapshot {
  // 深冻结，防止消费者意外改写文档
  const frozen = structuredClone(doc) as SkeletonDocument;
  deepFreeze(frozen);
  return {
    rev,
    doc: frozen,
    issues: Object.freeze(validateDocument(frozen)),
  };
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  Object.freeze(value);
  for (const key of Object.keys(value as Record<string, unknown>)) {
    const child = (value as Record<string, unknown>)[key];
    if (child && typeof child === 'object' && !Object.isFrozen(child)) deepFreeze(child);
  }
  return value;
}

export interface ExportData {
  format: 'skeleton-animation/1';
  exportedAt: string;
  rev: number;
  duration: number;
  /** 逐秒刻度（步长可配）的世界姿态采样，供外部播放器直接使用 */
  sampleRate: number;
  frames: Array<{
    time: number;
    bones: Array<{
      id: string;
      start: { x: number; y: number };
      end: { x: number; y: number };
      worldAngle: number;
      localAngle: number;
      length: number;
    }>;
  }>;
  document: SkeletonDocument;
  issues: ValidationIssue[];
}

/** 从同一个快照导出：文档、逐帧姿态、检查结果必然一致 */
export function exportSnapshot(
  snap: RevisionSnapshot,
  opts: { sampleRate?: number; rootPosition?: { x: number; y: number } } = {}
): ExportData {
  const sampleRate = opts.sampleRate ?? 24;
  const step = 1 / sampleRate;
  const times: number[] = [];
  for (let t = 0; t < snap.doc.duration - 1e-9; t += step) {
    times.push(Number(t.toFixed(6)));
  }
  times.push(snap.doc.duration);

  const frames = times.map((time) => {
    const pose: WorldPose = evaluatePose(snap.doc as SkeletonDocument, time, {
      rootPosition: opts.rootPosition ?? { x: 200, y: 300 },
    });
    return {
      time,
      bones: pose.map((w) => ({
        id: w.id,
        start: { x: w.start.x, y: w.start.y },
        end: { x: w.end.x, y: w.end.y },
        worldAngle: w.worldAngle,
        localAngle: w.localAngle,
        length: w.length,
      })),
    };
  });

  return {
    format: 'skeleton-animation/1',
    exportedAt: new Date().toISOString(),
    rev: snap.rev,
    duration: snap.doc.duration,
    sampleRate,
    frames,
    document: structuredClone(snap.doc),
    issues: snap.issues.map((i) => ({ ...i })),
  };
}
