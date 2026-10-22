/**
 * Finalize work scaling: FINALIZE must cost the open tail and its enumerated dependents, never the completed prefix.
 *
 * For each workload family, a session appends a completed prefix of N or 4N units followed by the same open tail, then
 * FINALIZE runs with the campaign counter sink reset. Total finalize work (every session counter across engine, patch
 * and store stages) at 4N divided by work at N must stay within the 1.25x scaling gate.
 *
 * Usage: npx tsx scripts/perf/finalize-scaling.ts [--family <name>] [--json <path>]
 * Requires the diagnostic bundle: npx tsx scripts/perf/build-diagnostic-bundle.ts
 */
import { writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { performance } from "node:perf_hooks";
import { type Patch, type WorkerIn, type WorkerOut, STREAM_MDX_SCHEMA_VERSION } from "@stream-mdx/core";
import type { RendererStoreOptions } from "@stream-mdx/react/renderer/store";
import type { MarkdownEngineOptions } from "../../packages/markdown-v2-worker/src/engine/types";
import type { SessionCountersSnapshot } from "./counter-sink";
import { MarkdownEngine, SessionCounterSink, createRendererStore } from "./diagnostic-dist/index.mjs";

const SCALING_GATE = 1.25;
const PREFIX_UNITS = 16_000;

const INIT: WorkerIn = {
  type: "INIT",
  schemaVersion: STREAM_MDX_SCHEMA_VERSION,
  initialContent: "",
  prewarmLangs: ["typescript"],
  docPlugins: {
    footnotes: true,
    html: true,
    mdx: false,
    tables: true,
    callouts: false,
    math: true,
    formatAnticipation: { inline: true, mathInline: true, mathBlock: true, html: true, mdx: false, regex: false },
    codeHighlighting: "incremental",
    outputMode: "both",
    emitHighlightTokens: true,
    emitDiffBlocks: false,
    themes: { dark: "github-dark", light: "github-light" },
  },
  mdx: { compileMode: "server" },
};

interface Family {
  /** One completed prefix block; it must end with a blank line so the next block starts fresh. */
  block(index: number): string;
  /** The open tail; identical at N and 4N. */
  tail: string;
}

const FAMILIES: Record<string, Family> = {
  paragraph: {
    block: (i) => `Paragraph ${i} has **strong** text and a [link](https://example.com/${i}).\n\n`,
    tail: "Open paragraph with *emphasis",
  },
  "code-tail": {
    block: (i) => `Paragraph ${i} before the code.\n\n`,
    tail: "```ts\nconst a = 1;\nconst b = 2;\nconst c",
  },
  "code-prefix": {
    block: (i) => `\`\`\`ts\nconst value${i} = ${i};\n\`\`\`\n\n`,
    tail: "Open paragraph after code",
  },
  heading: {
    block: (i) => `## Heading ${i}\n\n`,
    tail: "## Open heading",
  },
  list: {
    block: (i) => `- item ${i} one\n- item ${i} two\n\n## Section ${i}\n\n`,
    tail: "- open item",
  },
  quote: {
    block: (i) => `> quoted ${i} text\n\n## Section ${i}\n\n`,
    tail: "> open quote",
  },
  table: {
    block: (i) => `| a${i} | b |\n| - | - |\n| c | d |\n\n`,
    tail: "| open | t |\n| - | - |\n| x",
  },
  html: {
    block: (i) => `<div class="note">\nhtml ${i}\n</div>\n\n`,
    tail: "Open paragraph after html",
  },
  mixed: {
    block: (i) =>
      [
        `## Heading ${i}\n\n`,
        `Paragraph ${i} with \`code\` and a footnote.\n\n`,
        `- item ${i}\n- item ${i} b\n\n`,
        `> quote ${i}\n\n`,
        `\`\`\`js\nlet v${i} = ${i};\n\`\`\`\n\n`,
        `| h${i} | k |\n| - | - |\n| 1 | 2 |\n\n`,
      ][i % 6]!,
    tail: "Open mixed paragraph",
  },
};

function prefixOf(family: Family, units: number): string {
  let text = "";
  for (let index = 0; text.length < units; index += 1) text += family.block(index);
  return text;
}

const COUNTER_KEYS = [
  "lines_tokenized",
  "units_tokenized",
  "inline_source_units_prepared",
  "source_units_read",
  "source_units_materialized",
  "source_directory_entries_copied",
  "record_slots_allocated",
  "code_source_units_prepared",
  "snapshot_nodes_built",
  "prefix_comparisons",
  "patches_emitted",
  "store_records_touched",
  "blocks_reprepared",
] as const satisfies readonly (keyof SessionCountersSnapshot)[];

interface FinalizeMeasurement {
  prefixUnits: number;
  work: number;
  counters: Record<(typeof COUNTER_KEYS)[number], number>;
  patchOps: Record<string, number>;
  finalizeMs: number;
}

async function measureFinalize(
  family: Family,
  prefixUnits: number,
  chunkUnits: number,
  cpuProfilePath?: string,
): Promise<FinalizeMeasurement> {
  const sink = new SessionCounterSink();
  const store = createRendererStore(undefined, { campaignCounters: sink } as RendererStoreOptions & {
    campaignCounters?: SessionCounterSink;
  });
  let observing = false;
  let finalized = false;
  const patchOps: Record<string, number> = {};
  const engine = new MarkdownEngine({
    post: (message: WorkerOut) => {
      if (message.type === "INITIALIZED") store.resetSnapshot(message.snapshot);
      else if (message.type === "PATCH") {
        if (observing) {
          for (const patch of message.patches as Patch[]) patchOps[patch.op] = (patchOps[patch.op] ?? 0) + 1;
        }
        store.applyPatches(message.patches);
      } else if (message.type === "FINALIZED") finalized = true;
      else if (message.type === "ERROR") throw new Error(`worker error: ${message.error.message}`);
    },
    campaignCounters: sink,
  } as MarkdownEngineOptions & { campaignCounters?: SessionCounterSink });

  await engine.handle(INIT);
  const text = prefixOf(family, prefixUnits) + family.tail;
  const step = chunkUnits > 0 ? chunkUnits : text.length;
  for (let from = 0; from < text.length; from += step) {
    await engine.handle({ type: "APPEND", text: text.slice(from, from + step) });
  }
  sink.reset();
  observing = true;
  const profiler = cpuProfilePath ? new Session() : undefined;
  if (profiler) {
    profiler.connect();
    await profiler.post("Profiler.enable");
    await profiler.post("Profiler.start");
  }
  const startedAt = performance.now();
  await engine.handle({ type: "FINALIZE" });
  const finalizeMs = performance.now() - startedAt;
  if (profiler && cpuProfilePath) {
    const { profile } = await profiler.post("Profiler.stop");
    writeFileSync(cpuProfilePath, JSON.stringify(profile));
    profiler.disconnect();
  }
  observing = false;
  if (!finalized) throw new Error("FINALIZE did not post FINALIZED");
  const snapshot = sink.snapshot();
  const counters = Object.fromEntries(COUNTER_KEYS.map((key) => [key, snapshot[key]])) as FinalizeMeasurement["counters"];
  const work = COUNTER_KEYS.reduce((sum, key) => sum + snapshot[key], 0);
  return { prefixUnits: text.length - family.tail.length, work, counters, patchOps, finalizeMs };
}

interface FamilyResult {
  family: string;
  n: FinalizeMeasurement;
  fourN: FinalizeMeasurement;
  ratio: number;
  gatePassed: boolean;
}

interface Options {
  family?: string;
  jsonPath?: string;
  /** Units per APPEND; 0 appends the whole document at once. */
  chunkUnits: number;
  /** Writes a CPU profile of each family's 4N FINALIZE to `<prefix>-<family>.cpuprofile`. */
  cpuProfilePrefix?: string;
}

const USAGE = "Usage: finalize-scaling.ts [--family <name>] [--chunk <units, 0 = whole>] [--json <path>] [--cpu-prof <path prefix>]";

function parseArgs(argv: readonly string[]): Options {
  const options: Options = { chunkUnits: 256 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (value === undefined) throw new Error(USAGE);
    if (arg === "--family") options.family = value;
    else if (arg === "--json") options.jsonPath = value;
    else if (arg === "--chunk") options.chunkUnits = Number(value);
    else if (arg === "--cpu-prof") options.cpuProfilePrefix = value;
    else throw new Error(USAGE);
    index += 1;
  }
  if (options.family !== undefined && !(options.family in FAMILIES)) {
    throw new Error(`unknown family ${options.family}; known: ${Object.keys(FAMILIES).join(", ")}`);
  }
  if (!Number.isInteger(options.chunkUnits) || options.chunkUnits < 0) throw new Error("--chunk must be a non-negative integer");
  return options;
}

async function main(): Promise<void> {
  const { family: only, jsonPath, chunkUnits, cpuProfilePrefix } = parseArgs(process.argv.slice(2));
  const results: FamilyResult[] = [];
  for (const [name, family] of Object.entries(FAMILIES)) {
    if (only !== undefined && name !== only) continue;
    const n = await measureFinalize(family, PREFIX_UNITS, chunkUnits);
    const profilePath = cpuProfilePrefix ? `${cpuProfilePrefix}-${name}.cpuprofile` : undefined;
    const fourN = await measureFinalize(family, PREFIX_UNITS * 4, chunkUnits, profilePath);
    // Equal tails: tail-proportional finalize does the same work at both sizes.
    const ratio = fourN.work / Math.max(1, n.work);
    const gatePassed = ratio <= SCALING_GATE;
    results.push({ family: name, n, fourN, ratio, gatePassed });
    const grew = COUNTER_KEYS.filter((key) => fourN.counters[key] > n.counters[key] * SCALING_GATE && fourN.counters[key] > 8)
      .map((key) => `${key} ${n.counters[key]}->${fourN.counters[key]}`);
    console.log(
      `[finalize-scaling] ${gatePassed ? "ok  " : "FAIL"} ${name.padEnd(12)} work ${n.work} -> ${fourN.work} (x${ratio.toFixed(2)}) ` +
        `ms ${n.finalizeMs.toFixed(1)} -> ${fourN.finalizeMs.toFixed(1)}${grew.length > 0 ? `; grew: ${grew.join(", ")}` : ""}`,
    );
  }
  if (jsonPath) {
    writeFileSync(jsonPath, `${JSON.stringify({ gate: SCALING_GATE, prefixUnits: PREFIX_UNITS, chunkUnits, results }, null, 2)}\n`);
  }
  const failed = results.filter((result) => !result.gatePassed);
  console.log(`[finalize-scaling] ${results.length - failed.length}/${results.length} families within x${SCALING_GATE}`);
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
