import { describe, expect, it } from 'vitest';
import { createEditorStore } from '../src/core/store';
import { exportSnapshot, takeSnapshot } from '../src/core/snapshot';
import { evaluatePose } from '../src/core/skeleton';
import { validateDocument } from '../src/core/validation';

describe('统一修订快照', () => {
  it('播放画面、单帧检查、导出引用同一 rev', () => {
    const s = createEditorStore();
    const snap = s.getSnapshot();
    const data = exportSnapshot(snap, { sampleRate: 10, rootPosition: s.getState().rootPosition });    expect(data.rev).toBe(snap.rev);
    // 快照冻结
    expect(Object.isFrozen(snap.doc)).toBe(true);
    expect(() => {
      (snap.doc as { duration: number }).duration = 999;
    }).toThrow();
    // 导出自同一快照：0s 第一帧与直接求值一致
    const live = evaluatePose(s.getDoc(), 0, { rootPosition: s.getState().rootPosition });
    const exported = data.frames[0];
    for (const wb of live) {
      const eb = exported.bones.find((b) => b.id === wb.id)!;
      expect(eb.end.x).toBeCloseTo(wb.end.x, 9);
      expect(eb.end.y).toBeCloseTo(wb.end.y, 9);
    }
  });

  it('编辑后快照缓存失效，rev 前进', () => {
    const s = createEditorStore();
    const snap1 = s.getSnapshot();
    s.setDuration(3);
    const snap2 = s.getSnapshot();
    expect(snap2.rev).toBeGreaterThan(snap1.rev);
    expect(snap2.doc.duration).toBe(3);
  });

  it('导出包含逐帧采样（24fps）与文档', () => {
    const s = createEditorStore();
    const data = exportSnapshot(s.getSnapshot(), { sampleRate: 24 });
    expect(data.format).toBe('skeleton-animation/1');
    expect(data.frames.length).toBe(2 * 24 + 1);
    expect(data.frames[0].time).toBe(0);
    expect(data.frames[data.frames.length - 1].time).toBe(2);
    expect(data.document.bones).toBeDefined();
    expect(Array.isArray(data.issues)).toBe(true);
  });

  it('默认文档通过校验', () => {
    const s = createEditorStore();
    const issues = validateDocument(s.getDoc());
    expect(issues.filter((i) => i.level === 'error')).toHaveLength(0);
  });

  it('takeSnapshot 可独立用于任意文档', () => {
    const s = createEditorStore();
    const snap = takeSnapshot(7, s.getDoc());
    expect(snap.rev).toBe(7);
    expect(snap.issues.length).toBeGreaterThanOrEqual(0);
  });
});
