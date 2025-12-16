export class RNG {
  private seed: number;

  constructor(seed = 123456789) {
    this.seed = seed >>> 0;
  }

  next(): number {
    this.seed = (1664525 * this.seed + 1013904223) >>> 0;
    return this.seed / 0xffffffff;
  }

  int(min: number, max: number): number {
    if (max <= min) return min;
    const span = max - min + 1;
    return min + Math.floor(this.next() * span);
  }

  pick<T>(values: readonly T[]): T {
    if (values.length === 0) {
      throw new Error("Cannot pick from empty collection");
    }
    return values[this.int(0, values.length - 1)];
  }
}
