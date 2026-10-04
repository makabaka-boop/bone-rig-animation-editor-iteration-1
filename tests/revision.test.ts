import { describe, expect, it, vi } from 'vitest';
import { RevisionGate } from '../src/core/revision';

describe('修订闸门：迟到计算不覆盖新修订', () => {
  it('在途计算期间修订号前进，结果被丢弃', async () => {
    const gate = new RevisionGate(1);
    const onFresh = vi.fn();
    gate.run(() => 'late-result', onFresh);
    gate.bump(); // 新修订（撤销/结构编辑）
    await Promise.resolve();
    await Promise.resolve();
    expect(onFresh).not.toHaveBeenCalled();
  });

  it('修订未变时结果正常投递', async () => {
    const gate = new RevisionGate(1);
    const onFresh = vi.fn();
    gate.run(async () => 42, onFresh);
    await vi.waitFor(() => expect(onFresh).toHaveBeenCalledWith(42));
  });

  it('sync 对齐外部修订号后，旧修订号的在途任务失效', async () => {
    const gate = new RevisionGate(1);
    const onFresh = vi.fn();
    gate.run(() => 'a', onFresh);
    gate.sync(5);
    await vi.waitFor(() => expect(onFresh).not.toHaveBeenCalled());
    expect(gate.isCurrent(5)).toBe(true);
    expect(gate.isCurrent(1)).toBe(false);
  });

  it('模拟连续拖动：旧指针位置的迟到 IK 不得覆盖最新指针', async () => {
    const gate = new RevisionGate(1);
    const applied: string[] = [];
    // 第 1 次拖动计算，延迟 20ms
    gate.run<string>(
      () => new Promise((r) => setTimeout(() => r('drag-1'), 20)),
      (v) => applied.push(v)
    );
    // 指针立刻移动 -> 新修订
    gate.bump();
    gate.run<string>(
      () => new Promise((r) => setTimeout(() => r('drag-2'), 5)),
      (v) => applied.push(v)
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(applied).toEqual(['drag-2']);
  });
});
