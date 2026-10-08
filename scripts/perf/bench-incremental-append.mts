import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TreeFragment } from "@lezer/common";
import { parser as mdParser } from "@lezer/markdown";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(
  __dirname,
  "../../apps/docs/public/perf/fixtures/naive-bayes.md",
);

if (!fs.existsSync(fixturePath)) {
  console.error(`Fixture not found at: ${fixturePath}`);
  process.exit(1);
}

const content = fs.readFileSync(fixturePath, "utf8");
const CHUNK_SIZE = 16;
const RUNS = 3;

function runBefore(): number {
  let doc = "";
  const t0 = performance.now();
  for (let i = 0; i < content.length; i += CHUNK_SIZE) {
    doc += content.slice(i, i + CHUNK_SIZE);
    // Prior behavior: Tree.fragments was undefined so every append performed a full parse
    mdParser.parse(doc);
  }
  return performance.now() - t0;
}

function runAfter(): number {
  let doc = "";
  let fragments: readonly TreeFragment[] | undefined = undefined;
  const t0 = performance.now();
  for (let i = 0; i < content.length; i += CHUNK_SIZE) {
    const chunk = content.slice(i, i + CHUNK_SIZE);
    const oldLen = doc.length;
    doc += chunk;
    const newLen = doc.length;

    if (fragments && fragments.length > 0) {
      fragments = TreeFragment.applyChanges(fragments, [
        { fromA: oldLen, toA: oldLen, fromB: oldLen, toB: newLen },
      ]);
    }
    const tree = mdParser.parse(doc, fragments);
    fragments = TreeFragment.addTree(tree, fragments);
  }
  return performance.now() - t0;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

console.log(`Benchmarking append parse cost on naive-bayes.md (${content.length} chars, chunk size: ${CHUNK_SIZE})...`);

// Warmup
runBefore();
runAfter();

const beforeRuns: number[] = [];
for (let i = 1; i <= RUNS; i++) {
  const ms = runBefore();
  beforeRuns.push(ms);
  console.log(`Before run ${i}: ${ms.toFixed(2)} ms`);
}

const afterRuns: number[] = [];
for (let i = 1; i <= RUNS; i++) {
  const ms = runAfter();
  afterRuns.push(ms);
  console.log(`After run ${i}: ${ms.toFixed(2)} ms`);
}

const beforeMedian = median(beforeRuns);
const afterMedian = median(afterRuns);

console.log("\n--- Results ---");
console.log(`Before (full parse per append) runs: [${beforeRuns.map((r) => r.toFixed(2)).join(", ")}] ms | Median: ${beforeMedian.toFixed(2)} ms`);
console.log(`After (incremental TreeFragment) runs: [${afterRuns.map((r) => r.toFixed(2)).join(", ")}] ms | Median: ${afterMedian.toFixed(2)} ms`);
