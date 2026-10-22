import { createRequire } from "node:module";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { JSDOM } from "jsdom";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { STREAM_MDX_SCHEMA_VERSION, type WorkerIn, type WorkerOut } from "@stream-mdx/core";
import { ComponentRegistry, createRendererStore, MarkdownBlocksRenderer, type RendererStore } from "@stream-mdx/react/server";
import { compileMarkdownSnapshotDirect } from "@stream-mdx/worker/direct";
import { MarkdownEngine } from "@stream-mdx/worker/engine";
import { normalizeHtmlSemantics } from "../../tests/conformance/normalizer.mts";
import type { DenseFixture } from "../perf/replay-fixtures";

const requireFromHere = createRequire(import.meta.url);
const { DENSE_FIXTURES } = requireFromHere("../perf/replay-fixtures.ts") as { DENSE_FIXTURES: DenseFixture[] };

interface SpecExample {
  markdown: string;
  section: string;
  number: number;
}

interface EngineRunner {
  engine: MarkdownEngine;
  messages: WorkerOut[];
}

interface EngineSession {
  runner: EngineRunner;
  store: RendererStore;
}

type CorpusFilter = "all" | "spec" | "nested" | "fixtures";
type ComparisonPhase = "publication" | "finalize";

interface Failure {
  id: string;
  chunking: string;
  phase: ComparisonPhase;
  frontier: number;
  append: number;
  firstDifference: number;
  streamedLength: number;
  referenceLength: number;
  streamedContext: string;
  referenceContext: string;
}

interface RunCounts {
  examples: number;
  chunkings: number;
  publicationFrontiers: number;
  finalizedComparisons: number;
}

interface ParityReport {
  version: 1;
  generatedAt: string;
  corpus: CorpusFilter;
  fixtureSampleSeed: string;
  durationMs: number;
  counts: RunCounts & { failures: number };
  failures: Failure[];
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURE_SAMPLE_SEED = 0x5eed2119;
const MAX_FIXTURE_FRONTIERS = 40;
const FIXTURE_CHUNK_SIZE = 64;
const NESTED_CHUNK_SIZES = [...Array.from({ length: 13 }, (_, index) => index + 1), 17, 29];
const SPEC_GFM_TAB = /→/g;

const INIT_CONFIG = {
  schemaVersion: STREAM_MDX_SCHEMA_VERSION,
  docPlugins: { html: true, tables: true, footnotes: true, math: true, callouts: true, mdx: false },
  mdx: { compileMode: "server" as const },
  prewarmLangs: [],
};

const NESTED_CONTAINER_SEEDS = [
  "> para\n>\n> | a |\n> | - |\n> | b |\n> | c |\n",
  "- x\n\n  | a |\n  | - |\n  | b |\n\n  | c |\n  | - |\n  | d |\n",
  "- | h |\n  | - |\n  | 1 |\n  | 2 |\n  | 3 |\n  | 4 |\n  | 5 |\n  | 6 |\n  | 7 |\n  | 8 |\n",
  "- ```\n  code\n  ```\n\n  | a |\n  | - |\n  | b |\n",
  "- a\n\n  | a |\n  | - |\n  | b |\n- next\n  more\n",
  "- x\n\n  > | a |\n  > | - |\n  > | b |\n  > | c |\n",
  "> x\n> y\n>\n> z\n\n- a\n- b\n\n  c\n",
  "> | a | b |\n> | - | :-: |\n> | 1 | 2 |\n> | 3 | 4 |\n> | 5 | 6 |\n",
  "> | a |\n> | - |\n> | b |\n> | c |\n>\n> after\n",
  "- | a |\n  | - |\n  | b |\n  | c |\n  | d |\n- next\n",
  "- x\n\n  | a |\n  | - |\n  | b |\n  | c |\n",
  "> | a |\r\n> | - |\r\n> | b |\r\n> | c |\r\n",
  "> | a | b |\n> | - | - |\n> *x* | y |\n> -1 | 2 |\n> # | z |\n",
  "> - | a |\n>   | - |\n>   | b |\n>   | c |\n",
  "> | a |\n> | - |\n> b\n> c `\\|` d\n\npara\n",
  "1. | a |\n   | - |\n   | b |\n\n   tail\n",
] as const;

const originalWarn = console.warn;
const originalError = console.error;

function silenceConsole(): void {
  console.warn = (...args: unknown[]) => {
    const message = String(args[0] ?? "");
    if (
      message.includes("[Shiki]") ||
      message.includes("Failed to load language") ||
      message.startsWith("Unsupported language ")
    ) {
      return;
    }
    originalWarn(...args);
  };
  console.error = (...args: unknown[]) => {
    const message = String(args[0] ?? "");
    if (message.includes("useLayoutEffect does nothing on the server") || message.includes("Language `")) return;
    originalError(...args);
  };
}

function restoreConsole(): void {
  console.warn = originalWarn;
  console.error = originalError;
}

function parseArgs(args: string[]): { corpus: CorpusFilter; jsonPath?: string } {
  let corpus: CorpusFilter = "all";
  let jsonPath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--corpus") {
      const value = args[index + 1];
      if (value !== "spec" && value !== "nested" && value !== "fixtures") {
        throw new Error("Usage: run-render-frontier-parity.mts [--corpus spec|nested|fixtures] [--json <path>]");
      }
      corpus = value;
      index += 1;
    } else if (arg === "--json") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--json requires a path");
      }
      jsonPath = path.resolve(process.cwd(), value);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { corpus, jsonPath };
}

function createRunner(): EngineRunner {
  const messages: WorkerOut[] = [];
  const engine = new MarkdownEngine({ post: (message) => messages.push(message) });
  return { engine, messages };
}

async function request(runner: EngineRunner, message: WorkerIn): Promise<WorkerOut[]> {
  // handle() serializes requests and resolves only after processMessage finishes.
  await runner.engine.handle(message);
  return runner.messages.splice(0);
}

function consumeMessages(session: EngineSession, messages: WorkerOut[], label: string): void {
  for (const message of messages) {
    if (message.type === "ERROR") {
      throw new Error(`${label}: ${message.phase}: ${message.error.message}`);
    }
    if (message.type === "INITIALIZED") {
      session.store.resetSnapshot(message.snapshot);
    } else if (message.type === "PATCH") {
      session.store.applyPatches(message.patches);
    }
  }
}

async function beginSession(runner: EngineRunner, label: string): Promise<EngineSession> {
  const session = { runner, store: createRendererStore() };
  const init = { type: "INIT", initialContent: "", ...INIT_CONFIG } as WorkerIn;
  const messages = await request(runner, init);
  if (!messages.some((message) => message.type === "INITIALIZED")) {
    const error = messages.find((message) => message.type === "ERROR");
    throw new Error(`${label}: worker did not initialize${error?.type === "ERROR" ? `: ${error.error.message}` : ""}`);
  }
  consumeMessages(session, messages, label);
  return session;
}

async function append(session: EngineSession, text: string, label: string): Promise<void> {
  const messages = await request(session.runner, { type: "APPEND", text });
  consumeMessages(session, messages, label);
}

async function finalize(session: EngineSession, label: string): Promise<void> {
  const messages = await request(session.runner, { type: "FINALIZE" });
  consumeMessages(session, messages, label);
  if (!messages.some((message) => message.type === "FINALIZED")) {
    throw new Error(`${label}: worker did not emit FINALIZED`);
  }
}

function renderStore(store: RendererStore): string {
  const markup = renderToStaticMarkup(
    React.createElement(MarkdownBlocksRenderer, {
      blocks: [],
      store,
      componentRegistry: new ComponentRegistry(),
    }),
  );
  return normalizeHtmlSemantics(markup);
}

async function renderColdPrefix(runner: EngineRunner, prefix: string, label: string): Promise<string> {
  const session = await beginSession(runner, label);
  await append(session, prefix, label);
  return renderStore(session.store);
}

async function renderColdStatic(source: string): Promise<string> {
  const compiled = await compileMarkdownSnapshotDirect({ text: source, init: INIT_CONFIG });
  return renderStore(createRendererStore(compiled.blocks));
}

function firstDifference(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) index += 1;
  return index;
}

function differenceContext(value: string, difference: number): string {
  const start = Math.max(0, difference - 60);
  return value.slice(start, Math.min(value.length, start + 120));
}

function recordComparison(
  counts: RunCounts,
  failures: Failure[],
  args: {
    id: string;
    chunking: string;
    phase: ComparisonPhase;
    frontier: number;
    append: number;
    streamed: string;
    reference: string;
  },
): void {
  if (args.phase === "publication") counts.publicationFrontiers += 1;
  else counts.finalizedComparisons += 1;
  if (args.streamed === args.reference) return;

  const difference = firstDifference(args.streamed, args.reference);
  failures.push({
    id: args.id,
    chunking: args.chunking,
    phase: args.phase,
    frontier: args.frontier,
    append: args.append,
    firstDifference: difference,
    streamedLength: args.streamed.length,
    referenceLength: args.reference.length,
    streamedContext: differenceContext(args.streamed, difference),
    referenceContext: differenceContext(args.reference, difference),
  });
}

async function loadSpecExamples(): Promise<Array<SpecExample & { id: string }>> {
  const files = [
    path.join(ROOT, "tests/conformance/fixtures/commonmark-spec-0.31.2.json"),
    path.join(ROOT, "tests/conformance/fixtures/gfm-spec-extensions.json"),
  ];
  const examples: Array<SpecExample & { id: string }> = [];
  for (const [fileIndex, fixturePath] of files.entries()) {
    const parsed = JSON.parse(await fs.readFile(fixturePath, "utf8")) as Array<SpecExample & { html: string }>;
    for (const example of parsed) {
      examples.push({
        id: `${fileIndex === 0 ? "cm" : "gfm"}_${example.number}`,
        section: example.section,
        number: example.number,
        markdown: example.markdown.replace(SPEC_GFM_TAB, "\t"),
      });
    }
  }
  return examples;
}

async function runSpecCorpus(
  streamRunner: EngineRunner,
  coldRunner: EngineRunner,
  counts: RunCounts,
  failures: Failure[],
): Promise<void> {
  const examples = await loadSpecExamples();
  counts.examples += examples.length;
  for (const example of examples) {
    const source = example.markdown;
    const coldFinal = await renderColdStatic(source);


    for (let split = 0; split <= source.length; split += 1) {
      counts.chunkings += 1;
      const session = await beginSession(streamRunner, `${example.id}/split-${split}`);
      let prefixLength = 0;
      const chunks = [source.slice(0, split), source.slice(split)];
      for (const [appendIndex, chunk] of chunks.entries()) {
        await append(session, chunk, `${example.id}/split-${split}/append-${appendIndex + 1}`);
        prefixLength += chunk.length;
        const streamed = renderStore(session.store);
        const reference = await renderColdPrefix(coldRunner, source.slice(0, prefixLength), `${example.id}/cold-prefix-${prefixLength}`);
        recordComparison(counts, failures, {
          id: example.id,
          chunking: `split@${split}`,
          phase: "publication",
          frontier: prefixLength,
          append: appendIndex + 1,
          streamed,
          reference,
        });
      }
      await finalize(session, `${example.id}/split-${split}/finalize`);
      recordComparison(counts, failures, {
        id: example.id,
        chunking: `split@${split}`,
        phase: "finalize",
        frontier: source.length,
        append: 2,
        streamed: renderStore(session.store),
        reference: coldFinal,
      });
    }
  }
}

function splitAtSize(source: string, size: number): string[] {
  const chunks: string[] = [];
  for (let offset = 0; offset < source.length; offset += size) {
    chunks.push(source.slice(offset, offset + size));
  }
  return chunks.length > 0 ? chunks : [""];
}

async function runNestedCorpus(
  streamRunner: EngineRunner,
  coldRunner: EngineRunner,
  counts: RunCounts,
  failures: Failure[],
): Promise<void> {
  counts.examples += NESTED_CONTAINER_SEEDS.length;
  for (const [seedIndex, source] of NESTED_CONTAINER_SEEDS.entries()) {
    const id = `nested_${seedIndex + 1}`;
    const coldFinal = await renderColdStatic(source);

    for (const chunkSize of NESTED_CHUNK_SIZES) {
      counts.chunkings += 1;
      const chunks = splitAtSize(source, chunkSize);
      const session = await beginSession(streamRunner, `${id}/size-${chunkSize}`);
      let prefixLength = 0;
      for (const [appendIndex, chunk] of chunks.entries()) {
        await append(session, chunk, `${id}/size-${chunkSize}/append-${appendIndex + 1}`);
        prefixLength += chunk.length;
        const streamed = renderStore(session.store);
        const reference = await renderColdPrefix(coldRunner, source.slice(0, prefixLength), `${id}/cold-prefix-${prefixLength}`);
        recordComparison(counts, failures, {
          id,
          chunking: `size=${chunkSize}`,
          phase: "publication",
          frontier: prefixLength,
          append: appendIndex + 1,
          streamed,
          reference,
        });
      }
      await finalize(session, `${id}/size-${chunkSize}/finalize`);
      recordComparison(counts, failures, {
        id,
        chunking: `size=${chunkSize}`,
        phase: "finalize",
        frontier: source.length,
        append: chunks.length,
        streamed: renderStore(session.store),
        reference: coldFinal,
      });
    }
  }
}

function hashSeed(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
  }
  return hash >>> 0;
}

function createRandom(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function sampledFixtureFrontiers(id: string, source: string): number[] {
  const candidates: number[] = [];
  for (let offset = FIXTURE_CHUNK_SIZE; offset < source.length; offset += FIXTURE_CHUNK_SIZE) {
    candidates.push(offset);
  }
  const random = createRandom((FIXTURE_SAMPLE_SEED ^ hashSeed(id)) >>> 0);
  for (let index = candidates.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [candidates[index], candidates[swapIndex]] = [candidates[swapIndex], candidates[index]];
  }
  const selected = candidates.slice(0, MAX_FIXTURE_FRONTIERS).sort((left, right) => left - right);
  selected.push(source.length);
  return selected;
}

async function runFixtureCorpus(
  streamRunner: EngineRunner,
  coldRunner: EngineRunner,
  counts: RunCounts,
  failures: Failure[],
): Promise<void> {
  counts.examples += DENSE_FIXTURES.length;
  for (const fixture of DENSE_FIXTURES) {
    const source = fixture.source;
    const coldFinal = await renderColdStatic(source);

    counts.chunkings += 1;
    const chunks = splitAtSize(source, FIXTURE_CHUNK_SIZE);
    const sampled = new Set(sampledFixtureFrontiers(fixture.id, source));
    const session = await beginSession(streamRunner, `${fixture.id}/size-${FIXTURE_CHUNK_SIZE}`);
    let prefixLength = 0;
    for (const [appendIndex, chunk] of chunks.entries()) {
      await append(session, chunk, `${fixture.id}/size-${FIXTURE_CHUNK_SIZE}/append-${appendIndex + 1}`);
      prefixLength += chunk.length;
      if (!sampled.has(prefixLength)) continue;

      const streamed = renderStore(session.store);
      const reference = await renderColdPrefix(coldRunner, source.slice(0, prefixLength), `${fixture.id}/cold-prefix-${prefixLength}`);
      recordComparison(counts, failures, {
        id: fixture.id,
        chunking: `size=${FIXTURE_CHUNK_SIZE}/seed=0x${FIXTURE_SAMPLE_SEED.toString(16)}`,
        phase: "publication",
        frontier: prefixLength,
        append: appendIndex + 1,
        streamed,
        reference,
      });
    }
    await finalize(session, `${fixture.id}/size-${FIXTURE_CHUNK_SIZE}/finalize`);
    recordComparison(counts, failures, {
      id: fixture.id,
      chunking: `size=${FIXTURE_CHUNK_SIZE}/seed=0x${FIXTURE_SAMPLE_SEED.toString(16)}`,
      phase: "finalize",
      frontier: source.length,
      append: chunks.length,
      streamed: renderStore(session.store),
      reference: coldFinal,
    });
  }
}

function printFailure(failure: Failure): void {
  console.log(
    `DIFF id=${failure.id} chunking=${failure.chunking} phase=${failure.phase} frontier=${failure.frontier} append=${failure.append} at=${failure.firstDifference} streamed=${JSON.stringify(failure.streamedContext)} reference=${JSON.stringify(failure.referenceContext)}`,
  );
}

async function main(): Promise<void> {
  const { corpus, jsonPath } = parseArgs(process.argv.slice(2));
  const startedAt = performance.now();
  silenceConsole();
  const { window: domWindow } = new JSDOM("");
  Object.assign(globalThis, {
    window: domWindow,
    document: domWindow.document,
    DOMParser: domWindow.DOMParser,
    Node: domWindow.Node,
    Element: domWindow.Element,
    HTMLElement: domWindow.HTMLElement,
  });

  const counts: RunCounts = { examples: 0, chunkings: 0, publicationFrontiers: 0, finalizedComparisons: 0 };
  const failures: Failure[] = [];
  const streamRunner = createRunner();
  const coldRunner = createRunner();
  try {
    if (corpus === "all" || corpus === "spec") {
      await runSpecCorpus(streamRunner, coldRunner, counts, failures);
    }
    if (corpus === "all" || corpus === "nested") {
      await runNestedCorpus(streamRunner, coldRunner, counts, failures);
    }
    if (corpus === "all" || corpus === "fixtures") {
      await runFixtureCorpus(streamRunner, coldRunner, counts, failures);
    }
  } finally {
    streamRunner.engine.dispose();
    coldRunner.engine.dispose();
    domWindow.close();
    restoreConsole();
  }

  const durationMs = Math.round(performance.now() - startedAt);
  const report: ParityReport = {
    version: 1,
    generatedAt: new Date().toISOString(),
    corpus,
    fixtureSampleSeed: `0x${FIXTURE_SAMPLE_SEED.toString(16)}`,
    durationMs,
    counts: { ...counts, failures: failures.length },
    failures,
  };
  if (jsonPath) {
    await fs.mkdir(path.dirname(jsonPath), { recursive: true });
    await fs.writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  }

  console.log(
    `[render-frontier-parity] corpus=${corpus} seed=${report.fixtureSampleSeed} examples=${counts.examples} chunkings=${counts.chunkings} frontiers=${counts.publicationFrontiers} finalized=${counts.finalizedComparisons} failures=${failures.length} durationMs=${durationMs}`,
  );
  for (const failure of failures.slice(0, 20)) printFailure(failure);
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  restoreConsole();
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`render-frontier-parity failed: ${message}\n`);
  process.exitCode = 1;
});
