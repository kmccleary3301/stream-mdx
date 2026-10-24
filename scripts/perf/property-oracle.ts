#!/usr/bin/env tsx

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import fc from "fast-check";

import {
  STREAM_MDX_SCHEMA_VERSION,
  applyPatchBatch,
  cloneBlock,
  createInitialSnapshot,
  type Block,
  type DocumentSnapshot,
  type Patch,
  type WorkerIn,
  type WorkerOut,
} from "@stream-mdx/core";
import {
  createSeededRandomChunks,
  findForcedSplitPoints,
  splitLinesPreservingEndings,
} from "./replay-fixtures";
import {
  blocksSemanticallyEqual,
  describeBlockSemanticDifference,
  describeProvisionalTailSemanticDifference,
  provisionalTailBlocksSemanticallyEqual,
} from "./semantic-block-comparison";

type ChunkMode = "whole" | "per-line" | "arbitrary";
type Snapshot = DocumentSnapshot;
interface EngineInstance {
  handle(message: WorkerIn): Promise<void>;
  dispose(): void;
}
type EngineConstructor = new (options: { post: (message: WorkerOut) => void }) => EngineInstance;

interface ChunkPlan {
  mode: ChunkMode;
  chunks: string[];
  boundaries: number[];
}

interface CorpusCase {
  name: string;
  source: string;
  mode?: ChunkMode;
  splitPoints?: number[];
}

interface GeneratedInput {
  source: string;
  randomSplitPoints: number[];
}

interface CapturedPublication {
  tx: number;
  frontier: number;
  blocks: Block[];
}

interface Divergence {
  source: string;
  mode: ChunkMode;
  boundaries: number[];
  frontier: number;
  tx: number;
  message: string;
}

interface RunOptions {
  runs: number;
  seed: number;
  mutation: boolean;
}

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const requireFromScript = createRequire(path.join(scriptDirectory, "property-oracle.ts"));
const markdownEngineConstructorPromise = requireFromScript("./property-oracle-engine.cjs") as Promise<EngineConstructor>;
let markdownEngineConstructor: EngineConstructor | undefined;
const corpusPath = path.join(scriptDirectory, "property-oracle-corpus.json");
const defaultRuns = 12;
const defaultSeed = 20261016;

const PARITY_INIT = {
  type: "INIT",
  schemaVersion: STREAM_MDX_SCHEMA_VERSION,
  initialContent: "",
  prewarmLangs: ["typescript", "javascript", "markdown"],
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
} satisfies Extract<WorkerIn, { type: "INIT" }>;

function parseOptions(args: string[]): RunOptions {
  const options: RunOptions = { runs: defaultRuns, seed: defaultSeed, mutation: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--runs" || arg === "--seed") {
      const value = args[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      const parsed = Number(value);
      if (!Number.isInteger(parsed)) throw new Error(`${arg} must be an integer`);
      if (arg === "--runs") options.runs = parsed;
      else options.seed = parsed;
      index++;
    } else if (arg.startsWith("--runs=")) {
      options.runs = Number(arg.slice("--runs=".length));
    } else if (arg.startsWith("--seed=")) {
      options.seed = Number(arg.slice("--seed=".length));
    } else if (arg === "--mutation=drop-last-patch") {
      options.mutation = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!Number.isInteger(options.runs) || options.runs < 1) throw new Error("--runs must be a positive integer");
  if (!Number.isInteger(options.seed)) throw new Error("--seed must be an integer");
  return options;
}

function chunksFromBoundaries(source: string, points: readonly number[]): string[] {
  const boundaries = [...new Set(points)]
    .filter((point) => Number.isInteger(point) && point > 0 && point < source.length)
    .sort((left, right) => left - right);
  const chunks: string[] = [];
  let start = 0;
  for (const boundary of boundaries) {
    chunks.push(source.slice(start, boundary));
    start = boundary;
  }
  chunks.push(source.slice(start));
  return chunks;
}

function chunkBoundaries(chunks: readonly string[]): number[] {
  const boundaries: number[] = [];
  let offset = 0;
  for (let index = 0; index < chunks.length - 1; index++) {
    offset += chunks[index].length;
    boundaries.push(offset);
  }
  return boundaries;
}

function plan(mode: ChunkMode, chunks: string[]): ChunkPlan {
  return { mode, chunks, boundaries: chunkBoundaries(chunks) };
}

function corpusPlans(entry: CorpusCase, seed: number): ChunkPlan[] {
  if (entry.mode !== undefined) {
    return [plan(entry.mode, chunksFromBoundaries(entry.source, entry.splitPoints ?? []))];
  }
  return [
    plan("whole", [entry.source]),
    plan("per-line", splitLinesPreservingEndings(entry.source)),
    plan("arbitrary", createSeededRandomChunks(entry.source, seed)),
  ];
}

function createFoldedEngine(mutateFirstBatch: boolean): {
  engine: EngineInstance;
  getSnapshot: () => Snapshot | undefined;
  getError: () => string | undefined;
  getPublications: () => CapturedPublication[];
  setOfferedFrontier: (frontier: number) => void;
} {
  let snapshot: Snapshot | undefined;
  let error: string | undefined;
  let frontier = 0;
  let offeredFrontier = 0;
  let mutated = false;
  const publications: CapturedPublication[] = [];
  const Engine = markdownEngineConstructor;
  if (!Engine) throw new Error("MarkdownEngine source loader was not initialized");
  const engine = new Engine({
    post: (message: WorkerOut) => {
      if (message.type === "ERROR") {
        error ??= `${message.phase}: ${message.error.message}`;
        return;
      }
      if (message.type === "INITIALIZED") {
        try {
          snapshot = createInitialSnapshot(message.snapshot);
        } catch (cause) {
          error ??= `INITIALIZED snapshot could not be folded: ${String(cause)}`;
        }
        return;
      }
      if (message.type !== "PATCH") return;
      if (!snapshot) {
        error ??= `PATCH ${message.tx} arrived before INITIALIZED`;
        return;
      }

      let hasExplicitFrontier = false;
      for (const patch of message.patches) {
        if (patch.op === "appendInputSource") {
          frontier = patch.from + patch.text.length;
          hasExplicitFrontier = true;
        }
      }
      if (!hasExplicitFrontier) frontier = offeredFrontier;

      let patches: Patch[] = message.patches;
      if (mutateFirstBatch && !mutated && message.patches.some((patch) => patch.op !== "appendInputSource")) {
        // Test-only mutation: drop the last patch of the first semantic batch.
        patches = patches.slice(0, -1);
        mutated = true;
      }
      try {
        applyPatchBatch(snapshot, patches);
        // Source-ledger-only batches advance the prefix but do not publish semantic blocks.
        if (message.patches.every((patch) => patch.op === "appendInputSource")) return;
        publications.push({
          tx: message.tx,
          frontier,
          blocks: snapshot.getBlocks().map(cloneBlock),
        });
      } catch (cause) {
        error ??= `PATCH ${message.tx} could not be folded: ${String(cause)}`;
      }
    },
  });
  return {
    engine,
    getSnapshot: () => snapshot,
    getError: () => error,
    getPublications: () => publications,
    setOfferedFrontier: (nextFrontier) => {
      offeredFrontier = nextFrontier;
    },
  };
}

async function parseCold(source: string, finalize: boolean): Promise<Block[]> {
  const folded = createFoldedEngine(false);
  try {
    await folded.engine.handle(PARITY_INIT);
    if (source.length > 0) {
      folded.setOfferedFrontier(source.length);
      await folded.engine.handle({ type: "APPEND", text: source });
    }
    if (finalize) await folded.engine.handle({ type: "FINALIZE" });
    if (folded.getError()) throw new Error(folded.getError());
    const snapshot = folded.getSnapshot();
    if (!snapshot) throw new Error("Cold engine did not publish INITIALIZED.snapshot");
    return snapshot.getBlocks().map(cloneBlock);
  } finally {
    folded.engine.dispose();
  }
}

function compareBlockLists(
  current: readonly Block[],
  cold: readonly Block[],
  requireFinalizedParity = false,
): string | undefined {
  if (current.length !== cold.length) {
    return `block count mismatch (folded=${current.length}, cold=${cold.length})`;
  }
  for (let index = 0; index < current.length; index++) {
    const currentBlock = current[index];
    const coldBlock = cold[index];
    if (requireFinalizedParity && currentBlock.isFinalized !== coldBlock.isFinalized) {
      return `block ${index} ${currentBlock.id} finality differs after FINALIZE (folded=${currentBlock.isFinalized}, cold=${coldBlock.isFinalized})`;
    }
    if (currentBlock.isFinalized && !coldBlock.isFinalized) {
      return `block ${index} ${currentBlock.id} finalized while the cold prefix tail is provisional`;
    }
    const provisionalTail = index === current.length - 1 && !currentBlock.isFinalized && coldBlock.isFinalized;
    const equal = provisionalTail
      ? provisionalTailBlocksSemanticallyEqual(currentBlock, coldBlock)
      : blocksSemanticallyEqual(currentBlock, coldBlock);
    if (!equal) {
      const difference = provisionalTail
        ? describeProvisionalTailSemanticDifference(currentBlock, coldBlock)
        : describeBlockSemanticDifference(currentBlock, coldBlock);
      return `block ${index} ${currentBlock.id} differs: ${difference}`;
    }
  }
  return undefined;
}

async function runPlan(source: string, chunkPlan: ChunkPlan, mutateFirstBatch = false): Promise<Divergence | undefined> {
  const folded = createFoldedEngine(mutateFirstBatch);
  const publications = folded.getPublications();
  let nextPublication = 0;
  let offeredFrontier = 0;
  const failure = (frontier: number, tx: number, message: string): Divergence => ({
    source,
    mode: chunkPlan.mode,
    boundaries: chunkPlan.boundaries,
    frontier,
    tx,
    message,
  });

  const compareNewPublications = async (): Promise<Divergence | undefined> => {
    while (nextPublication < publications.length) {
      const publication = publications[nextPublication++];
      const prefix = source.slice(0, publication.frontier);
      let coldBlocks: Block[];
      try {
        coldBlocks = await parseCold(prefix, false);
      } catch (cause) {
        return failure(publication.frontier, publication.tx, `Cold non-finalizing parse failed: ${String(cause)}`);
      }
      const difference = compareBlockLists(publication.blocks, coldBlocks);
      if (difference) {
        return failure(publication.frontier, publication.tx, `Open-prefix divergence: ${difference}`);
      }
    }
    return undefined;
  };

  try {
    await folded.engine.handle(PARITY_INIT);
    if (folded.getError()) return failure(0, -1, folded.getError()!);
    for (const chunk of chunkPlan.chunks) {
      if (chunk.length > 0) {
        offeredFrontier += chunk.length;
        folded.setOfferedFrontier(offeredFrontier);
        await folded.engine.handle({ type: "APPEND", text: chunk });
      }
      if (folded.getError()) return failure(offeredFrontier, -1, folded.getError()!);
      const divergence = await compareNewPublications();
      if (divergence) return divergence;
    }

    await folded.engine.handle({ type: "FINALIZE" });
    if (folded.getError()) return failure(source.length, -1, folded.getError()!);
    const snapshot = folded.getSnapshot();
    if (!snapshot) return failure(source.length, -1, "Stream engine did not publish INITIALIZED.snapshot");

    let coldFinalBlocks: Block[];
    try {
      coldFinalBlocks = await parseCold(source, true);
    } catch (cause) {
      return failure(source.length, -1, `Cold finalized parse failed: ${String(cause)}`);
    }
    const difference = compareBlockLists(snapshot.getBlocks(), coldFinalBlocks, true);
    if (difference) return failure(source.length, -1, `Finalized divergence: ${difference}`);
    return undefined;
  } catch (cause) {
    return failure(offeredFrontier, -1, `Engine replay failed: ${String(cause)}`);
  } finally {
    folded.engine.dispose();
  }
}

const newlineArbitrary = fc.constantFrom("\n", "\r\n");
const wordArbitrary = fc.array(fc.constantFrom("a", "b", "x", "🚀", "𠮷"), {
  minLength: 1,
  maxLength: 4,
}).map((units) => units.join(""));

const blockArbitrary: fc.Arbitrary<string> = fc.oneof(
  wordArbitrary.map((word) => `Paragraph ${word}`),
  fc.tuple(wordArbitrary, newlineArbitrary).map(([word, newline]) =>
    `Inline ${word} *em* **strong** \`code\` [link](/path) [ref][late] [^note] <kbd>key</kbd> <sub>2</sub>${newline}[late]: /target${newline}[^note]: ${word}`,
  ),
  fc.tuple(wordArbitrary, newlineArbitrary).map(([word, newline]) => `# Heading ${word}${newline}${newline}Setext ${word}${newline}---`),
  fc.tuple(wordArbitrary, newlineArbitrary).map(([word, newline]) => `~~~ts${newline}const value = \"${word}\";${newline}~~~`),
  fc.tuple(wordArbitrary, newlineArbitrary).map(([word, newline]) => `    const value = \"${word}\";${newline}    return value`),
  fc.tuple(fc.array(wordArbitrary, { minLength: 1, maxLength: 4 }), newlineArbitrary).map(([rows, newline]) =>
    `| key | value |${newline}| :--- | ---: |${newline}${rows.map((value, index) => `| row${index} | ${value} |`).join(newline)}`,
  ),
  fc.tuple(wordArbitrary, newlineArbitrary).map(([word, newline]) => `1. parent ${word}${newline}   - nested${newline}${newline}     loose continuation${newline}2. sibling`),
  fc.tuple(wordArbitrary, newlineArbitrary).map(([word, newline]) => `> quote ${word}${newline}> continuation`),
  fc.tuple(wordArbitrary, newlineArbitrary).map(([word, newline]) => `Reference [${word}][late]${newline}${newline}[late]: /${word}`),
  fc.tuple(wordArbitrary, newlineArbitrary).map(([word, newline]) => `Footnote[^note]${newline}${newline}[^note]: ${word}`),
);

const unclosedTailArbitrary = fc.oneof(
  fc.tuple(wordArbitrary, newlineArbitrary).map(([word, newline]) => `~~~js${newline}const tail = "${word}";`),
  wordArbitrary.map((word) => `Unclosed <kbd>${word}`),
);

const documentArbitrary: fc.Arbitrary<string> = fc.tuple(
  newlineArbitrary,
  fc.array(blockArbitrary, { minLength: 1, maxLength: 4 }),
  fc.option(unclosedTailArbitrary, { nil: null }),
).map(([newline, blocks, tail]) => {
  const body = blocks.join(`${newline}${newline}`);
  return tail === null ? body : `${body}${newline}${newline}${tail}`;
});

const generatedInputArbitrary: fc.Arbitrary<GeneratedInput> = documentArbitrary.chain((source) =>
  fc.array(fc.integer({ min: 0, max: source.length }), { maxLength: 6 })
    .map((randomSplitPoints) => ({ source, randomSplitPoints })),
);
const mutationInputArbitrary: fc.Arbitrary<GeneratedInput> = wordArbitrary.map((word) => ({
  source: `p ${word}`,
  randomSplitPoints: [],
}));

function generatedPlans(input: GeneratedInput): ChunkPlan[] {
  const arbitraryBoundaries = [
    ...findForcedSplitPoints(input.source),
    ...input.randomSplitPoints,
  ];
  return [
    plan("whole", [input.source]),
    plan("per-line", splitLinesPreservingEndings(input.source)),
    plan("arbitrary", chunksFromBoundaries(input.source, arbitraryBoundaries)),
  ];
}

async function runGeneratedInput(input: GeneratedInput): Promise<Divergence | undefined> {
  for (const chunkPlan of generatedPlans(input)) {
    const divergence = await runPlan(input.source, chunkPlan);
    if (divergence) return divergence;
  }
  return undefined;
}

function printDivergence(label: string, divergence: Divergence): void {
  console.error(`${label}: ${divergence.message}`);
  console.error(`  document: ${JSON.stringify(divergence.source)}`);
  console.error(`  chunk mode: ${divergence.mode}; UTF-16 boundaries: ${JSON.stringify(divergence.boundaries)}`);
  console.error(`  first divergent frontier: ${divergence.frontier} (tx ${divergence.tx})`);
}

function saveShrunkCase(corpus: CorpusCase[], divergence: Divergence): boolean {
  const duplicate = corpus.some((entry) => entry.source === divergence.source && entry.mode === divergence.mode &&
    JSON.stringify(entry.splitPoints ?? []) === JSON.stringify(divergence.boundaries));
  if (duplicate) return false;
  const nextIndex = corpus.reduce((max, entry) => Math.max(max, Number(/^shrunk-(\d+)$/.exec(entry.name)?.[1] ?? 0)), 0) + 1;
  corpus.push({
    name: `shrunk-${String(nextIndex).padStart(3, "0")}`,
    source: divergence.source,
    mode: divergence.mode,
    splitPoints: divergence.boundaries,
  });
  fs.writeFileSync(corpusPath, `${JSON.stringify(corpus, null, 2)}\n`);
  return true;
}

function loadCorpus(): CorpusCase[] {
  const parsed: unknown = JSON.parse(fs.readFileSync(corpusPath, "utf8"));
  if (!Array.isArray(parsed)) throw new Error(`${corpusPath} must contain a JSON array`);
  return parsed as CorpusCase[];
}

// Corpus entries are already recorded and seeded chunking is deterministic, so failures here are
// reported, not re-saved; only new shrunk counterexamples from generated runs extend the corpus.
async function runCorpus(corpus: readonly CorpusCase[], seed: number): Promise<number> {
  let failures = 0;
  for (const entry of corpus) {
    for (const chunkPlan of corpusPlans(entry, seed)) {
      const divergence = await runPlan(entry.source, chunkPlan);
      if (!divergence) continue;
      failures++;
      printDivergence(`Corpus ${entry.name}`, divergence);
    }
  }
  return failures;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  markdownEngineConstructor = await markdownEngineConstructorPromise;
  const startedAt = performance.now();
  const corpus = loadCorpus();
  const corpusCaseCount = corpus.length;
  const corpusFailureCount = await runCorpus(corpus, options.seed);
  let generatedFailureCount = 0;
  let mutationKilled = false;
  let shrinkPath: string | null = null;

  let lastFailure: Divergence | undefined;
  const propertyArbitrary = options.mutation ? mutationInputArbitrary : generatedInputArbitrary;
  const property = fc.asyncProperty(propertyArbitrary, async (input) => {
    lastFailure = options.mutation
      ? await runPlan(input.source, plan("whole", [input.source]), true)
      : await runGeneratedInput(input);
    return lastFailure === undefined;
  });
  const result = await fc.check(property, { seed: options.seed, numRuns: options.runs });

  if (result.failed) {
    shrinkPath = result.counterexamplePath;
    let divergence = lastFailure;
    let failedSource = divergence?.source;
    const counterexample = result.counterexample?.[0];
    if (counterexample && typeof counterexample === "object" && "source" in counterexample) {
      failedSource = String(counterexample.source);
      const input = counterexample as GeneratedInput;
      divergence = options.mutation
        ? await runPlan(input.source, plan("whole", [input.source]), true) ?? divergence
        : await runGeneratedInput(input) ?? divergence;
    }
    if (divergence) {
      if (options.mutation) {
        const baseline = failedSource
          ? await runPlan(failedSource, plan("whole", [failedSource]))
          : divergence;
        if (!baseline) {
          mutationKilled = true;
          printDivergence("Mutation killed after fast-check shrinking", divergence);
          console.log(`Mutation sanity check passed: baseline passed and mutant failed (path ${shrinkPath ?? "unknown"}).`);
        } else {
          printDivergence("Mutation check was not isolated", baseline);
        }
      } else {
        generatedFailureCount++;
        printDivergence("Shrunk property failure", divergence);
        if (saveShrunkCase(corpus, divergence)) console.error("  recorded the shrunk case in property-oracle-corpus.json");
      }
    }
  }

  const durationMs = Math.round(performance.now() - startedAt);
  console.log(
    `Property oracle: ${corpusCaseCount} corpus cases, ${result.numRuns}/${options.runs} generated runs ` +
      `(${result.numShrinks} successful shrinks, seed ${options.seed}), ` +
      `${corpusFailureCount + generatedFailureCount} divergence(s), ${durationMs} ms${options.mutation ? ", mutation mode" : ""}.`,
  );

  if (options.mutation) {
    if (!mutationKilled) {
      console.error("Mutation sanity check failed: dropping a patch did not make the property fail.");
      process.exitCode = 1;
    } else if (corpusFailureCount > 0) {
      process.exitCode = 1;
    }
  } else if (corpusFailureCount + generatedFailureCount > 0) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
