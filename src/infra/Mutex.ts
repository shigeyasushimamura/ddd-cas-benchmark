export class Mutex {
  // IDごとの待ち行列（resolve関数の配列）
  private queues = new Map<string, (() => void)[]>();
  // IDごとのロック状態
  private locked = new Set<string>();

  async lock(key: string): Promise<void> {
    // すでにロックされていたら、列に並ぶ
    if (this.locked.has(key)) {
      return new Promise<void>((resolve) => {
        const queue = this.queues.get(key) || [];
        queue.push(resolve);
        this.queues.set(key, queue);
      });
    }

    // ロックされていなければ、ロックする
    this.locked.add(key);
  }

  unlock(key: string): void {
    const queue = this.queues.get(key);

    if (queue && queue.length > 0) {
      // 次の人を呼ぶ（ロック状態は維持）
      const nextResolver = queue.shift();
      if (nextResolver) nextResolver();
    } else {
      // 誰も待っていなければロック解除
      this.locked.delete(key);
      this.queues.delete(key);
    }
  }
}
