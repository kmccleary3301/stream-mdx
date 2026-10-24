export class ViewportHeightIndex {
  private count = 0;
  private estimate = 20;
  private readonly measuredHeights = new Map<number, number>();
  private readonly heightDeltas = new Map<number, number>();

  reset(count: number, estimate: number): void {
    this.count = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
    this.estimate = Number.isFinite(estimate) && estimate > 0 ? estimate : 20;
    this.measuredHeights.clear();
    this.heightDeltas.clear();
  }

  resize(count: number): void {
    const nextCount = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
    if (nextCount === this.count) return;
    if (nextCount < this.count) {
      for (let index = nextCount; index < this.count; index += 1) {
        this.measuredHeights.delete(index);
        this.heightDeltas.delete(index + 1);
      }
      this.count = nextCount;
      return;
    }

    for (let index = this.count + 1; index <= nextCount; index += 1) {
      const start = index - (index & -index);
      const delta = this.prefix(index - 1) - this.prefix(start);
      if (delta !== 0) this.heightDeltas.set(index, delta);
    }
    this.count = nextCount;
  }

  setHeight(index: number, height: number): boolean {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.count || !Number.isFinite(height) || height <= 0) {
      return false;
    }
    const previous = this.measuredHeights.get(index) ?? this.estimate;
    if (Math.abs(previous - height) <= 0.5) return false;
    this.measuredHeights.set(index, height);
    this.add(index + 1, height - previous);
    return true;
  }

  offsetAt(index: number): number {
    const end = Number.isFinite(index) ? Math.max(0, Math.min(this.count, Math.floor(index))) : 0;
    return end * this.estimate + this.prefix(end);
  }

  indexAt(offset: number): number {
    if (this.count === 0) return 0;
    const target = Number.isNaN(offset) ? 0 : Math.max(0, Math.min(offset, this.offsetAt(this.count)));
    let index = 0;
    let delta = 0;
    let bit = 1;
    while (bit <= Math.floor(this.count / 2)) bit *= 2;
    while (bit > 0) {
      const next = index + bit;
      if (next <= this.count) {
        const nextDelta = delta + (this.heightDeltas.get(next) ?? 0);
        if (next * this.estimate + nextDelta <= target) {
          index = next;
          delta = nextDelta;
        }
      }
      bit = Math.floor(bit / 2);
    }
    return index;
  }

  private prefix(count: number): number {
    let total = 0;
    for (let index = count; index > 0; index -= index & -index) total += this.heightDeltas.get(index) ?? 0;
    return total;
  }

  private add(index: number, delta: number): void {
    for (let cursor = index; cursor <= this.count; cursor += cursor & -cursor) {
      const next = (this.heightDeltas.get(cursor) ?? 0) + delta;
      if (next === 0) this.heightDeltas.delete(cursor);
      else this.heightDeltas.set(cursor, next);
    }
  }
}
