import assert from "node:assert";

import type { NodePath, Patch } from "../src/types";

import { DEFAULT_COALESCE_CONFIG, coalescePatchesWithMetrics } from "../src/perf/patch-coalescing";
import { RNG } from "./helpers/rng";

type LineCountSummary = Record<string, number>;

interface Scenario {
  seed: number;
  blockCount: number;
  operations: number;
}

const BASE_NODE_KINDS = ["paragraph", "code", "list", "blockquote"] as const;

function nodePathKey(path: NodePath): string {
  const nodePart = path.nodeId ?? "";
  const indexPart = path.indexPath && path.indexPath.length > 0 ? `::${path.indexPath.join(".")}` : "";
  return `${path.blockId}::${nodePart}${indexPart}`;
}

function clonePath(path: NodePath): NodePath {
  return {
    blockId: path.blockId,
    nodeId: path.nodeId,
    indexPath: path.indexPath ? [...path.indexPath] : undefined,
  };
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function normalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeValue(entry));
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return entries.reduce<Record<string, unknown>>((acc, [key, val]) => {
      acc[key] = normalizeValue(val);
      return acc;
    }, {});
  }
  return value;
}

function registerPath(meta: Map<string, number>, path: NodePath): void {
  const key = nodePathKey(path);
  if (!meta.has(key)) {
    meta.set(key, 0);
  }
}

function generateNodePaths(blockId: string): NodePath[] {
  const paths: NodePath[] = [{ blockId }];
  for (const kind of BASE_NODE_KINDS) {
    paths.push({ blockId, nodeId: `${blockId}::${kind}` });
  }
  return paths;
}

function pickWithBias<T>(rng: RNG, pool: T[], last: T | null, bias = 0.4): T {
  if (last && rng.next() < bias) {
    return last;
  }
  return rng.pick(pool);
}

function generatePatches({ seed, blockCount, operations }: Scenario): Patch[] {
  const rng = new RNG(seed);
  const blockIds = Array.from({ length: blockCount }, (_, i) => `block-${i}`);
  const allPaths: NodePath[] = [];
  const lineMeta = new Map<string, number>();
  let lastAppendPath: NodePath | null = null;
  let lastPropsPath: NodePath | null = null;

  for (const blockId of blockIds) {
    const paths = generateNodePaths(blockId);
    paths.forEach((path) => registerPath(lineMeta, path));
    allPaths.push(...paths);
  }

  const appendTargets = allPaths.filter((path) => path.nodeId);
  const setPropsTargets = [...allPaths];
  const patches: Patch[] = [];
  while (patches.length < operations) {
    const op = rng.pick(["appendLines", "setProps"] as const);
    if (op === "appendLines") {
      const path = pickWithBias(rng, appendTargets, lastAppendPath);
      lastAppendPath = path;
      const key = nodePathKey(path);
      const offset = lineMeta.get(key) ?? 0;
      const startIndex = offset;
      const lineCount = rng.int(1, 6);
      const lines = Array.from({ length: lineCount }, (_, idx) => `line-${startIndex + idx}-${seed}-${patches.length}`);
      const includeHighlights = rng.next() > 0.5;
      const highlight = includeHighlights ? Array.from({ length: lineCount }, () => rng.pick(["meta", "diff", null])) : undefined;
      lineMeta.set(key, startIndex + lineCount);
      patches.push({
        op: "appendLines",
        at: clonePath(path),
        startIndex,
        lines,
        highlight,
      });
      continue;
    }

    if (op === "setProps") {
      const path = pickWithBias(rng, setPropsTargets, lastPropsPath);
      lastPropsPath = path;
      patches.push({
        op: "setProps",
        at: clonePath(path),
        props: {
          flags: {
            bold: rng.next() > 0.5,
            italic: rng.next() > 0.5,
            underline: rng.next() > 0.5,
          },
          depth: rng.int(0, 4),
          variant: rng.pick(["primary", "secondary", "warning"]),
          updatedAt: Date.now() + rng.int(0, 1000),
        },
      });
      continue;
    }

  }

  return patches;
}

function summarizeLineStats(patches: Patch[]): LineCountSummary {
  const summary = new Map<string, number>();
  for (const patch of patches) {
    if (patch.op !== "appendLines") continue;
    const key = nodePathKey(patch.at);
    const lines = patch.lines ?? [];
    summary.set(key, (summary.get(key) ?? 0) + lines.length);
  }
  return Object.fromEntries([...summary.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function summarizeProps(patches: Patch[]): Record<string, unknown> {
  const propsMap = new Map<string, Record<string, unknown>>();
  for (const patch of patches) {
    if (patch.op === "setProps") {
      propsMap.set(nodePathKey(patch.at), normalizeValue(patch.props ?? {}));
    } else if (patch.op === "setPropsBatch") {
      for (const entry of patch.entries) {
        propsMap.set(nodePathKey(entry.at), normalizeValue(entry.props ?? {}));
      }
    }
  }
  return Object.fromEntries(
    [...propsMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, value]),
  );
}

function runScenario(scenario: Scenario): void {
  const patches = generatePatches(scenario);
  const baselineLines = summarizeLineStats(patches);
  const baselineProps = summarizeProps(patches);

  const withMetricsInput = patches.map((patch) => deepClone(patch));
  const { patches: coalesced, metrics } = coalescePatchesWithMetrics(withMetricsInput, DEFAULT_COALESCE_CONFIG);

  const coalescedLines = summarizeLineStats(coalesced);
  const coalescedProps = summarizeProps(coalesced);
  assert.deepStrictEqual(
    coalescedLines,
    baselineLines,
    `Line summaries changed after coalescing (seed=${scenario.seed}, blocks=${scenario.blockCount})`,
  );
  assert.deepStrictEqual(
    coalescedProps,
    baselineProps,
    `Prop summaries changed after coalescing (seed=${scenario.seed}, blocks=${scenario.blockCount})`,
  );

  assert.ok(coalesced.length <= patches.length, "coalescing should never increase patch count");
  assert.strictEqual(metrics.inputPatchCount, patches.length);
  assert.strictEqual(metrics.outputPatchCount, coalesced.length);
  assert.strictEqual(metrics.coalescedCount, patches.length - coalesced.length);
  assert.ok(metrics.durationMs >= 0);
  assert.ok(metrics.appendLinesCoalesced >= 0);
  assert.ok(metrics.setPropsCoalesced >= 0);
  assert.ok(metrics.insertChildCoalesced >= 0);
}

const scenarios: Scenario[] = [
  { seed: 101, blockCount: 1, operations: 250 },
  { seed: 5555, blockCount: 2, operations: 450 },
  { seed: 98765, blockCount: 3, operations: 600 },
];

for (const scenario of scenarios) {
  runScenario(scenario);
}

console.log("Coalescing property tests passed");
