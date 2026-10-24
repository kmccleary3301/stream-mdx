/**
 * Worker-side streaming replay: drives MarkdownEngine in Node with the same chunk trace the browser
 * perf harness uses (parity feature profile), back to back, so worker cost is isolated from the page.
 * Measures the built `@stream-mdx/worker/engine` entry: run `npm run build:packages` first.
 *
 * Usage: npx tsx scripts/perf/replay-worker-engine.mts --fixture stress-mega --scenario S9_firehose_20k [--json out.json]
 * Profile: node --cpu-prof --cpu-prof-dir <dir> --import tsx scripts/perf/replay-worker-engine.mts ...
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { WorkerIn, WorkerOut } from "@stream-mdx/core";
import { STREAM_MDX_SCHEMA_VERSION } from "@stream-mdx/core";
import { MarkdownEngine } from "@stream-mdx/worker/engine";
import { createChunkTrace } from "./chunk-trace";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

const round = (value: number) => Math.round(value * 10) / 10;

// Mirrors PARITY_FEATURES in apps/docs/components/perf/perf-harness.tsx as mapped by the React renderer's INIT.
const PARITY_INIT: WorkerIn = { type: "INIT", schemaVersion: STREAM_MDX_SCHEMA_VERSION, initialContent: "",
prewarmLangs: [],
docPlugins: {
  footnotes: true,
  html: true,
  mdx: false,
  tables: true,
  callouts: false,
  math: true,
  formatAnticipation: { inline: true, mathInline: true, mathBlock: true, html: true, mdx: false, regex: false },
  liveCodeHighlighting: true,
  emitDiffBlocks: false,
},
mdx: { compileMode: "server" }, } as WorkerIn;

async function main(): Promise<void> {
  const fixtureName = arg("fixture") ?? "stress-mega";
  const scenarioName = arg("scenario") ?? "S9_firehose_20k";
  const source = fs.readFileSync(path.join(repoRoot, "tests/regression/fixtures", `${fixtureName}.md`), "utf8");
  const scenario = JSON.parse(fs.readFileSync(path.join(repoRoot, "tests/regression/scenarios", `${scenarioName}.json`), "utf8"));
  const trace = createChunkTrace(source, scenario);

  let messages = 0;
  let patchMessages = 0;
  let patchBytes = 0;
  let finalized = false;
  let errors = 0;
  const engine = new MarkdownEngine({
    post: (message: WorkerOut) => {
      messages += 1;
      if (message.type === "PATCH") {
        patchMessages += 1;
        patchBytes += JSON.stringify(message).length;
      }
      if (message.type === "FINALIZED") finalized = true;
      if (message.type === "ERROR") {
        errors += 1;
        console.error("worker ERROR", message.error.message);
      }
    },
  });

  await engine.handle(PARITY_INIT);
  const appendMs: number[] = [];
  const start = performance.now();
  for (const chunk of trace) {
    const t0 = performance.now();
    await engine.handle({ type: "APPEND", text: chunk.text });
    appendMs.push(performance.now() - t0);
  }
  const appendTotal = performance.now() - start;
  const f0 = performance.now();
  await engine.handle({ type: "FINALIZE" });
  const finalizeMs = performance.now() - f0;
  if (!finalized) throw new Error("FINALIZED was not posted.");
  if (errors > 0) throw new Error(`${errors} worker errors.`);

  const streamMs = trace.at(-1)?.atMs ?? 0;
  const sorted = [...appendMs].sort((a, b) => a - b);
  const quarter = Math.floor(appendMs.length / 4);
  const quarterMeans = [0, 1, 2, 3].map((q) => {
    const slice = appendMs.slice(q * quarter, q === 3 ? appendMs.length : (q + 1) * quarter);
    return round(slice.reduce((sum, value) => sum + value, 0) / Math.max(1, slice.length));
  });
  const result = {
    fixture: fixtureName,
    scenario: scenarioName,
    chars: source.length,
    appends: trace.length,
    nominalStreamMs: streamMs,
    appendTotalMs: round(appendTotal),
    workerBusyRatio: round(appendTotal / Math.max(1, streamMs)),
    sustainableCps: Math.round(source.length / (appendTotal / 1000)),
    appendP50Ms: round(percentile(sorted, 0.5)),
    appendP95Ms: round(percentile(sorted, 0.95)),
    appendMaxMs: round(sorted.at(-1) ?? 0),
    firstAppendMs: round(appendMs[0] ?? 0),
    appendMeanByQuarterMs: quarterMeans,
    finalizeMs: round(finalizeMs),
    messages,
    patchMessages,
    patchMegabytes: round(patchBytes / 2 ** 20),
    // Retained engine heap after FINALIZE (forced GC when run with --expose-gc).
    retainedHeapMegabytes: round(retainedHeap() / 2 ** 20),
  };
  console.log(JSON.stringify(result, null, 2));
  const out = arg("json");
  if (out) fs.writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
}

function retainedHeap(): number {
  if ("gc" in globalThis && typeof globalThis.gc === "function") globalThis.gc();
  return process.memoryUsage().heapUsed;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
