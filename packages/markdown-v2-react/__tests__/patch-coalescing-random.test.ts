import assert from "node:assert";

import type { Patch } from "@stream-mdx/core";
import { coalescePatchesLinear, coalescePatchesQuadratic } from "../src/renderer/patch-coalescing";

// Deterministic RNG
class RNG {
  private seed: number;
  constructor(seed = 12345) {
    this.seed = seed >>> 0;
  }
  next(): number {
    this.seed = (1664525 * this.seed + 1013904223) >>> 0;
    return this.seed / 0xffffffff;
  }
  int(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }
  pick<T>(values: T[]): T {
    return values[this.int(0, values.length - 1)];
  }
}

function randomPatch(rng: RNG, blockId: string): Patch {
  const op = rng.pick(["appendLines", "setProps", "finalize"] as const);
  if (op === "appendLines") {
    const start = rng.int(0, 20);
    const count = rng.int(1, 5);
    return {
      op,
      at: { blockId },
      startIndex: start,
      lines: Array.from({ length: count }, (_, i) => `line-${start + i}`),
    };
  }
  if (op === "setProps") {
    const nodeId = `${blockId}::node:${rng.int(0, 3)}`;
    const flags = {
      bold: rng.int(0, 1) === 1,
      italic: rng.int(0, 1) === 1,
      underline: rng.int(0, 1) === 1,
    };
    return {
      op,
      at: { blockId, nodeId },
      props: { flags },
    };
  }
  return {
    op: "finalize",
    at: { blockId },
  };
}

function normalize(patches: Patch[]): unknown {
  return JSON.parse(JSON.stringify(patches));
}

function runRandomCoalescing(seed: number, iterations: number): void {
  const rng = new RNG(seed);
  for (let i = 0; i < iterations; i++) {
    const blockId = `block-${i}`;
    const count = rng.int(5, 30);
    const patches: Patch[] = [];
    for (let j = 0; j < count; j++) {
      patches.push(randomPatch(rng, blockId));
    }
    const linear = coalescePatchesLinear(patches.map((p) => structuredClone(p)));
    const quadratic = coalescePatchesQuadratic(patches.map((p) => structuredClone(p)));
    assert.deepStrictEqual(
      normalize(linear),
      normalize(quadratic),
      `Linear vs quadratic mismatch at iteration ${i}`,
    );
  }
}

runRandomCoalescing(123, 25);
runRandomCoalescing(9876, 25);

console.log("Randomized coalescing parity tests passed");
