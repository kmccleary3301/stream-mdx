import React from "react";

export type MdxHydrationStrategy = "immediate" | "staggered" | "visible";

export type MdxHydrationOptions = {
  strategy?: MdxHydrationStrategy;
  maxConcurrent?: number;
  delayMs?: number;
  rootMargin?: string;
  idleTimeoutMs?: number;
  debounceMs?: number;
};

type HydrationPermit = { release: () => void };

export class MdxHydrationController {
  private readonly maxConcurrent: number;
  private readonly delayMs: number;
  private active = 0;
  private queue: Array<() => void> = [];

  constructor(options?: MdxHydrationOptions) {
    this.maxConcurrent = Math.max(1, options?.maxConcurrent ?? 1);
    this.delayMs = Math.max(0, options?.delayMs ?? 0);
  }

  async acquire(): Promise<HydrationPermit> {
    if (this.active < this.maxConcurrent) {
      return this.grantPermit();
    }
    return new Promise((resolve) => {
      this.queue.push(() => resolve(this.grantPermit()));
    });
  }

  private grantPermit(): HydrationPermit {
    this.active += 1;
    return {
      release: () => {
        this.active = Math.max(0, this.active - 1);
        this.drainQueue();
      },
    };
  }

  private drainQueue() {
    if (this.active >= this.maxConcurrent || this.queue.length === 0) {
      return;
    }
    const next = this.queue.shift();
    if (!next) return;
    if (this.delayMs > 0) {
      setTimeout(next, this.delayMs);
      return;
    }
    next();
  }
}

export type MdxHydrationContextValue = {
  controller: MdxHydrationController | null;
  options?: MdxHydrationOptions;
};

export const MdxHydrationContext = React.createContext<MdxHydrationContextValue>({ controller: null });

export function createMdxHydrationController(options?: MdxHydrationOptions): MdxHydrationController | null {
  if (!options || options.strategy === "immediate") {
    return null;
  }
  return new MdxHydrationController(options);
}
