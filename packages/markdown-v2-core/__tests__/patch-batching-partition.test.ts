import assert from "node:assert";

import { getPatchKind, isHeavyPatch, splitPatchBatch } from "../src/perf/patch-batching";
import type { Patch } from "../src/types";

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

// Content-bearing ops are semantic and code decoration is enrichment, whatever the meta says.
{
  const enrichmentMeta = { kind: "enrichment" } as const;
  const contentPatches: Patch[] = [
    { op: "appendInputSource", at: { blockId: "__root__" }, generation: 1, from: 0, text: "x", meta: enrichmentMeta } as Patch,
    { op: "appendCode", at: { blockId: "c", nodeId: "c" }, lines: [], meta: enrichmentMeta } as unknown as Patch,
    { op: "appendParagraph", at: { blockId: "p", nodeId: "p" }, spans: [], meta: enrichmentMeta } as unknown as Patch,
    { op: "updateParagraphSpans", at: { blockId: "p", nodeId: "p" }, updates: [], meta: enrichmentMeta } as unknown as Patch,
    { op: "appendTableRows", at: { blockId: "t", nodeId: "t" }, rows: [], meta: enrichmentMeta } as unknown as Patch,
    { op: "updateTableRows", at: { blockId: "t", nodeId: "t" }, updates: [], meta: enrichmentMeta } as unknown as Patch,
  ];
  for (const patch of contentPatches) assert.strictEqual(getPatchKind(patch), "semantic", `${patch.op} carries content and is never deferrable`);
  const decoration = { op: "decorateCode", at: { blockId: "c", nodeId: "c" }, decorations: [], meta: { kind: "semantic" } } as unknown as Patch;
  assert.strictEqual(getPatchKind(decoration), "enrichment", "code decoration is always enrichment");
  const setHtmlEnrichment = { op: "setHTML", at: { blockId: "h", nodeId: "h" }, html: "<b>x</b>", patchMeta: { kind: "enrichment" } } as unknown as Patch;
  assert.strictEqual(getPatchKind(setHtmlEnrichment), "enrichment", "setHTML honors patchMeta.kind");
  const setHtmlWithPlainMeta = { op: "setHTML", at: { blockId: "h", nodeId: "h" }, html: "<b>x</b>", meta: { kind: "enrichment" } } as unknown as Patch;
  assert.strictEqual(getPatchKind(setHtmlWithPlainMeta), "semantic", "setHTML reads patchMeta, not meta");
}

function generatePatches(random: () => number): Patch[] {
  const length = Math.floor(random() * 40);
  const patches: Patch[] = [];
  for (let index = 0; index < length; index += 1) {
    const id = `n${index}`;
    const roll = random();
    const kind = random() < 0.5 ? "enrichment" : random() < 0.5 ? "semantic" : undefined;
    const meta = kind ? { kind } : undefined;
    if (roll < 0.35) {
      patches.push({ op: "setProps", at: { blockId: id, nodeId: id }, props: { value: index }, meta } as Patch);
    } else if (roll < 0.5) {
      const block = { id, type: random() < 0.5 ? "code" : "paragraph", isFinalized: false, payload: { raw: "x" } };
      patches.push({ op: "setProps", at: { blockId: id, nodeId: id }, props: { block }, meta } as Patch);
    } else if (roll < 0.65) {
      patches.push({ op: "decorateCode", at: { blockId: id, nodeId: id }, decorations: new Array(Math.floor(random() * 9)).fill({}) } as unknown as Patch);
    } else if (roll < 0.75) {
      patches.push({ op: "setHTML", at: { blockId: id, nodeId: id }, html: "<i>x</i>", patchMeta: meta } as unknown as Patch);
    } else if (roll < 0.85) {
      patches.push({ op: "insertChild", at: { blockId: "root", nodeId: "root" }, index, node: { id, type: random() < 0.5 ? "code" : "paragraph", props: {}, children: [] }, meta } as Patch);
    } else {
      patches.push({ op: "appendInputSource", at: { blockId: "__root__" }, generation: 1, from: index, text: "x" } as Patch);
    }
  }
  return patches;
}

// The split is an ordered partition: semantic runs stay whole, enrichment is chunked and heavy enrichment isolated.
for (let seed = 1; seed <= 500; seed += 1) {
  const random = mulberry32(seed);
  const patches = generatePatches(random);
  const maxLightChunk = 1 + Math.floor(random() * 5);
  const groups = splitPatchBatch(patches, maxLightChunk);
  const label = `seed ${seed} (chunk ${maxLightChunk})`;

  assert.deepStrictEqual(groups.flat(), patches, `${label}: groups must contain every patch exactly once, in order`);
  for (const [index, group] of groups.entries()) {
    assert.ok(group.length > 0, `${label}: group ${index} is empty`);
    const kinds = new Set(group.map(getPatchKind));
    assert.strictEqual(kinds.size, 1, `${label}: group ${index} mixes semantic and enrichment patches`);
    if (kinds.has("enrichment")) {
      assert.ok(group.length <= maxLightChunk, `${label}: enrichment group ${index} exceeds the light chunk size`);
      if (group.some(isHeavyPatch)) assert.strictEqual(group.length, 1, `${label}: heavy enrichment patch must stand alone`);
    }
    const previous = groups[index - 1];
    if (!previous) continue;
    const previousKind = getPatchKind(previous[0] as Patch);
    const currentKind = getPatchKind(group[0] as Patch);
    assert.ok(!(previousKind === "semantic" && currentKind === "semantic"), `${label}: a semantic run was split at group ${index}`);
    if (previousKind === "enrichment" && currentKind === "enrichment") {
      const splitNeeded = previous.length === maxLightChunk || isHeavyPatch(previous[0] as Patch) || isHeavyPatch(group[0] as Patch);
      assert.ok(splitNeeded, `${label}: enrichment run was split before group ${index} without reaching the chunk size or a heavy patch`);
    }
  }
}

assert.deepStrictEqual(splitPatchBatch([]), [], "an empty batch has no groups");

console.log("patch batching partition test passed");
