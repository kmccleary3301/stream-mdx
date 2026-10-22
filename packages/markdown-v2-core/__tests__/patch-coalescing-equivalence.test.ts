import assert from "node:assert";

import { applyPatchBatch, createInitialSnapshot, type DocumentSnapshot } from "../src/block-snapshot";
import {
  type CoalesceConfig,
  DEFAULT_COALESCE_CONFIG,
  coalescePatchesLinear,
  coalescePatchesQuadratic,
  coalescePatchesWithMetrics,
} from "../src/perf/patch-coalescing";
import { PATCH_ROOT_ID, type NodePath, type Patch } from "../src/types";

// Coalescing is an optimization: for any patch sequence, applying the coalesced sequence must leave
// exactly the state that applying the original sequence leaves.

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const INITIAL_SOURCE_LENGTH = 20;
/** Own-block, block-only and in-block addressing: several nodes share a blockId, as list and quote children do. */
const PROP_TARGETS: readonly NodePath[] = [
  { blockId: "p1", nodeId: "p1" },
  { blockId: "p1" },
  { blockId: "p2", nodeId: "p2" },
  { blockId: "L", nodeId: "L" },
  { blockId: "L" },
  { blockId: "L", nodeId: "li1" },
  { blockId: "L", nodeId: "li2" },
  { blockId: "Q", nodeId: "Q" },
  { blockId: "Q", nodeId: "q1" },
];
/** Insert parents; `L` and `li1` share a blockId. */
const INSERT_PARENTS: readonly NodePath[] = [
  { blockId: "L", nodeId: "L" },
  { blockId: "L", nodeId: "li1" },
  { blockId: "Q", nodeId: "Q" },
];

function createSnapshot(): DocumentSnapshot {
  const leaf = (id: string, type: string) => ({ id, type, props: {}, children: [] });
  return createInitialSnapshot({
    id: PATCH_ROOT_ID,
    type: "__root__",
    inputSource: { generation: 1, raw: "x".repeat(INITIAL_SOURCE_LENGTH) },
    children: [
      leaf("p1", "paragraph"),
      leaf("p2", "paragraph"),
      { id: "L", type: "list", props: {}, children: [leaf("li1", "list-item"), leaf("li2", "list-item")] },
      { id: "Q", type: "blockquote", props: {}, children: [leaf("q1", "paragraph")] },
    ],
  } as never);
}

/** Deterministic valid patch sequence; regenerated per application so no application sees another's objects. */
function generatePatches(seed: number): Patch[] {
  const random = mulberry32(seed);
  const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)] as T;
  const integer = (max: number) => Math.floor(random() * (max + 1));
  const length = 1 + integer(64);
  let sourceLength = INITIAL_SOURCE_LENGTH;
  const childCounts = new Map<string, number>([["L", 2], ["li1", 0], ["Q", 1]]);
  let nextNode = 0;
  const target = (): NodePath => ({ ...pick(PROP_TARGETS) });
  const props = (): Record<string, unknown> => {
    const result: Record<string, unknown> = {};
    for (const key of ["a", "b", "c"]) {
      if (random() < 0.45) result[key] = random() < 0.2 ? undefined : integer(9);
    }
    if (random() < 0.2) result.range = { from: 0, to: integer(sourceLength + 6) };
    if (random() < 0.15) result.meta = random() < 0.3 ? null : { m: integer(9) };
    return result;
  };
  const patches: Patch[] = [];
  while (patches.length < length) {
    const roll = random();
    if (roll < 0.5) {
      patches.push({ op: "setProps", at: target(), props: props() });
    } else if (roll < 0.7) {
      const parent = pick(INSERT_PARENTS);
      const count = childCounts.get(parent.nodeId as string) ?? 0;
      const index = random() < 0.6 ? count : integer(count);
      const id = `n${nextNode++}`;
      patches.push({ op: "insertChild", at: { ...parent }, index, node: { id, type: "paragraph", props: {}, children: [] } });
      childCounts.set(parent.nodeId as string, count + 1);
    } else if (roll < 0.78) {
      const parent = pick(INSERT_PARENTS);
      const count = childCounts.get(parent.nodeId as string) ?? 0;
      if (count === 0) continue;
      patches.push({ op: "deleteChild", at: { ...parent }, index: integer(count - 1) });
      childCounts.set(parent.nodeId as string, count - 1);
    } else if (roll < 0.88) {
      patches.push({ op: "appendInputSource", at: { blockId: PATCH_ROOT_ID }, generation: 1, from: sourceLength, text: "abc" } as Patch);
      sourceLength += 3;
    } else {
      patches.push({ op: "setPropsBatch", entries: [{ at: target(), props: props() }, { at: target(), props: props() }] } as Patch);
    }
  }
  return patches;
}

function applied(patches: Patch[]): string {
  const snapshot = createSnapshot();
  applyPatchBatch(snapshot, patches);
  return snapshotState(snapshot);
}

/** Key order is not state: props merged in one patch may be inserted in a different order. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
  );
}

function snapshotState(snapshot: DocumentSnapshot): string {
  const nodes = [...snapshot.nodes.values()]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(({ id, type, parentId, children, props, meta, range }) => ({ id, type, parentId, children, props, meta, range }));
  return JSON.stringify(canonical(nodes));
}

const configs: Array<[string, CoalesceConfig]> = [
  ["default window", DEFAULT_COALESCE_CONFIG],
  ["window of 7", { ...DEFAULT_COALESCE_CONFIG, maxCoalesceWindow: 7 }],
];
const coalescers = [
  ["linear", coalescePatchesLinear],
  ["quadratic", coalescePatchesQuadratic],
] as const;

for (let seed = 1; seed <= 400; seed += 1) {
  const expected = applied(generatePatches(seed));
  for (const [configName, config] of configs) {
    for (const [coalescerName, coalesce] of coalescers) {
      const actual = applied(coalesce(generatePatches(seed), config));
      assert.strictEqual(actual, expected, `${coalescerName} coalescing (${configName}) changed the applied state for seed ${seed}`);
    }
  }
}

// Metrics report what coalescing removed, by op.
{
  const { patches, metrics } = coalescePatchesWithMetrics([
    { op: "setProps", at: { blockId: "p1", nodeId: "p1" }, props: { a: 1 } },
    { op: "setProps", at: { blockId: "p1", nodeId: "p1" }, props: { b: 2 } },
    { op: "setProps", at: { blockId: "p1", nodeId: "p1" }, props: { c: 3 } },
    { op: "insertChild", at: { blockId: "L", nodeId: "L" }, index: 2, node: { id: "x", type: "paragraph", props: {}, children: [] } },
    { op: "insertChild", at: { blockId: "L", nodeId: "L" }, index: 3, node: { id: "y", type: "paragraph", props: {}, children: [] } },
  ]);
  assert.strictEqual(patches.length, 3, "three same-node setProps merge into one; inserts stay individual");
  const { durationMs, ...counts } = metrics;
  assert.ok(durationMs >= 0, "duration is non-negative");
  assert.deepStrictEqual(counts, { inputPatchCount: 5, outputPatchCount: 3, coalescedCount: 2, setPropsCoalesced: 2, insertChildCoalesced: 0 });
}

console.log("patch coalescing equivalence test passed");
