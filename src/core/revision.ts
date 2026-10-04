/**
 * 修订闸门。拖动末端控制点时，IK 计算可能异步返回
 * （本项目中通过微任务/帧调度模拟计算延迟）。
 * 若计算期间文档产生了新修订（撤销、结构编辑等），
 * 迟到的结果必须被丢弃，不能覆盖新修订。
 */
export class RevisionGate {
  private rev: number;

  constructor(initialRev = 1) {
    this.rev = initialRev;
  }

  current(): number {
    return this.rev;
  }

  /** 产生一个新修订，返回新修订号 */
  bump(): number {
    this.rev += 1;
    return this.rev;
  }

  isCurrent(rev: number): boolean {
    return rev === this.rev;
  }

  /** 与外部修订号对齐（例如撤销/重做后），使在途计算全部失效 */
  sync(rev: number): void {
    this.rev = rev;
  }

  /**
   * 发起一次带修订号的计算。计算可以是同步值或 Promise；
   * 只有回调完成时修订号未变化，才会投递结果。
   * 返回本次计算绑定的修订号。
   */
  run<T>(
    compute: () => T | Promise<T>,
    onFresh: (value: T) => void
  ): { rev: number; cancelled: () => boolean } {
    const rev = this.rev;
    Promise.resolve()
      .then(() => compute())
      .then((value) => {
        if (this.rev === rev) onFresh(value);
      })
      .catch(() => {
        /* 计算失败按丢弃处理，不污染当前修订 */
      });
    return { rev, cancelled: () => this.rev !== rev };
  }
}
