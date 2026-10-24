import assert from "node:assert/strict";

import { once } from "node:events";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { STREAM_MDX_SCHEMA_VERSION, type Patch, type WorkerOut } from "@stream-mdx/core";
import { createRendererStore } from "../../markdown-v2-react/src/renderer/store";
import { createWorkerHarness, projectConsumerBlocks, type WorkerHarness } from "./worker-test-harness";

const MINIMAL_SOURCE = 'Prefix <InlineChip tone="warm"> and trailing.\n\nNext paragraph.\n';
const FIXTURE_SOURCE = readFileSync(
  new URL("../../../tests/regression/fixtures/mdx-tag-allowlist-inline.mdx", import.meta.url),
  "utf8",
);
const CHILD_ARGUMENT = "--mdx-tag-allowlist-cycle-child";

function chunksOfSize(source: string, size: number): string[] {
  const chunks: string[] = [];
  for (let offset = 0; offset < source.length; offset += size) chunks.push(source.slice(offset, offset + size));
  return chunks;
}

async function renderWithWorker(harness: WorkerHarness, chunks: readonly string[]) {
  const store = createRendererStore();
  const initMessages = await harness.send({
    type: "INIT",
    schemaVersion: STREAM_MDX_SCHEMA_VERSION,
    initialContent: "",
    prewarmLangs: [],
    contentPolicy: "restricted",
    contentComponents: [{ name: "InlineChip" }],
    docPlugins: {
      html: true,
      tables: true,
      footnotes: true,
      math: true,
      callouts: true,
      mdx: true,
      formatAnticipation: { inline: true, mdx: true },
    },
  });
  assertNoErrors(initMessages);
  const initialized = initMessages.find(
    (message): message is Extract<WorkerOut, { type: "INITIALIZED" }> => message.type === "INITIALIZED",
  );
  assert.ok(initialized, "worker must initialize before applying patches");
  store.resetSnapshot(initialized.snapshot);
  for (const message of initMessages) {
    if (message.type === "PATCH") store.applyPatches(message.patches as Patch[], { captureMetrics: false });
  }

  for (const chunk of chunks) {
    const messages = await harness.send({ type: "APPEND", text: chunk });
    assertNoErrors(messages);
    for (const message of messages) {
      if (message.type === "PATCH") store.applyPatches(message.patches as Patch[], { captureMetrics: false });
    }
  }

  const finalized = await harness.send({ type: "FINALIZE" });
  assertNoErrors(finalized);
  for (const message of finalized) {
    if (message.type === "PATCH") store.applyPatches(message.patches as Patch[], { captureMetrics: false });
  }
  assert.equal(finalized.at(-1)?.type, "FINALIZED", "worker must finish the document");
  return store;
}

function assertNoErrors(messages: readonly WorkerOut[]): void {
  for (const message of messages) {
    if (message.type === "ERROR") assert.fail(`Worker error during ${message.phase}: ${message.error.message}`);
  }
}

async function runWorkerStoreParity(source: string, label: string): Promise<void> {
  const cold = await renderWithWorker(await createWorkerHarness(), [source]);
  const streamed = await renderWithWorker(await createWorkerHarness(), chunksOfSize(source, 18));
  assert.deepEqual(
    projectConsumerBlocks(streamed.getBlocks()),
    projectConsumerBlocks(cold.getBlocks()),
    `${label}: chunked worker-to-store output must match the cold render`,
  );
}

interface ChildResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly output: string;
}

async function runChildWithWatchdog(label: string, timeoutMs: number): Promise<ChildResult> {
  const output: Buffer[] = [];
  const testPath = fileURLToPath(import.meta.url);
  const child = spawn(process.execPath, [...process.execArgv, testPath, CHILD_ARGUMENT, label], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => output.push(chunk));

  let timedOut = false;
  // This external timer must kill the child: a synchronous infinite store loop blocks the child's event loop,
  // so an in-process timeout or fake clock cannot interrupt the regression.
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);
  try {
    const [code, signal] = await once(child, "close") as [number | null, NodeJS.Signals | null];
    return { code, signal, timedOut, output: Buffer.concat(output).toString("utf8") };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { code: null, signal: null, timedOut, output: `${message}\n${Buffer.concat(output).toString("utf8")}` };
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  if (process.argv[2] === CHILD_ARGUMENT) {
    const label = process.argv[3];
    const source = label === "minimal" ? MINIMAL_SOURCE : label === "fixture" ? FIXTURE_SOURCE : undefined;
    assert.ok(source, `unknown child scenario ${label}`);
    await runWorkerStoreParity(source, label);
    console.log(`worker-to-store parity passed: ${label}`);
    return;
  }

  for (const label of ["minimal", "fixture"] as const) {
    const result = await runChildWithWatchdog(label, 5_000);
    assert.equal(
      result.timedOut,
      false,
      `${label}: worker-to-store stream exceeded its 5-second watchdog\n${result.output}`,
    );
    assert.equal(
      result.code,
      0,
      `${label}: worker-to-store stream must complete and match its cold render (signal ${result.signal})\n${result.output}`,
    );
  }
}

await main();
