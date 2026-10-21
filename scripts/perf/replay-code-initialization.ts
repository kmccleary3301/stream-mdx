import { PATCH_ROOT_ID, STREAM_MDX_SCHEMA_VERSION, type CodeLineRecord, type WorkerIn, type WorkerOut } from "@stream-mdx/core";
import type { Highlighter } from "shiki";
import { MarkdownEngine, createRendererStore } from "./diagnostic-dist/index.mjs";
import { recordDivergence, type DenseFixture, type ChunkingPlan, type DivergenceReport } from "./replay-fixtures";
import { capturePriorCodeOwners, verifyCodeWirePatches, verifyCompletedLineTokens } from "./replay-code-parity";
import { collectBlocksRecursively, verifyIndependentExpectations } from "./replay-semantic-expectations";

export const PARITY_INIT = { type: "INIT", schemaVersion: STREAM_MDX_SCHEMA_VERSION, initialContent: "",
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
mdx: { compileMode: "server" }, } satisfies Extract<WorkerIn, { type: "INIT" }>;

export async function runRootCodeInitializationTrace(
  fixture: DenseFixture,
  highlighter: Highlighter,
): Promise<DivergenceReport[]> {
  const divergences: DivergenceReport[] = [];
  const plan: ChunkingPlan = { mode: "whole", seed: 0, chunks: [] };
  const followup = "\nPost-initialization source append.\n";
  const fullSource = fixture.source + followup;
  const store = createRendererStore();
  let initializationCount = 0;
  let initializedGeneration: number | undefined;
  let initialCodeOwners = new Set<string>();
  let patchTx = -1;
  const engine = new MarkdownEngine({
    post: (msg: WorkerOut) => {
      if (msg.type === "INITIALIZED") {
        initializationCount += 1;
        if (initializationCount > 1) {
          recordDivergence(
            divergences,
            fixture,
            plan,
            "initialized-root:duplicate",
            msg.generation,
            0,
            `Root-code trace received ${initializationCount} INITIALIZED messages`,
          );
        }
        if (msg.schemaVersion !== STREAM_MDX_SCHEMA_VERSION) {
          recordDivergence(
            divergences,
            fixture,
            plan,
            "initialized-root:schema",
            msg.generation,
            0,
            `INITIALIZED schema ${msg.schemaVersion} does not match ${STREAM_MDX_SCHEMA_VERSION}`,
          );
        }
        initializedGeneration = msg.generation;
        try {
          store.resetSnapshot(msg.snapshot);
        } catch (error) {
          recordDivergence(
            divergences,
            fixture,
            plan,
            "initialized-root:store-reset",
            msg.generation,
            0,
            `INITIALIZED root snapshot could not reset the renderer store: ${String(error)}`,
          );
          return;
        }
        initialCodeOwners = new Set(
          store.getBlocks()
            .filter((block) => block.type === "code" && store.getNode(block.id)?.parentId === PATCH_ROOT_ID)
            .map((block) => block.id),
        );
        return;
      }
      if (msg.type === "PATCH") {
        if (initializationCount !== 1) {
          recordDivergence(
            divergences,
            fixture,
            plan,
            "initialized-root:patch-order",
            msg.tx,
            0,
            "PATCH was published outside the single INITIALIZED root generation",
          );
        }
        if (msg.tx <= patchTx) {
          recordDivergence(
            divergences,
            fixture,
            plan,
            "initialized-root:fifo",
            msg.tx,
            0,
            `PATCH tx ${msg.tx} did not advance beyond ${patchTx}`,
          );
        }
        patchTx = msg.tx;
        const prior = capturePriorCodeOwners(msg.patches, store);
        try {
          store.applyPatches(msg.patches);
        } catch (error) {
          recordDivergence(
            divergences,
            fixture,
            plan,
            "initialized-root:patch-apply",
            msg.tx,
            0,
            `Store rejected root-code followup PATCH: ${String(error)}`,
          );
          return;
        }
        for (const patch of msg.patches) {
          if (
            patch.op === "insertChild" &&
            patch.at.blockId === PATCH_ROOT_ID &&
            initialCodeOwners.has(patch.node.id)
          ) {
            recordDivergence(
              divergences,
              fixture,
              plan,
              "initialized-root:duplicate-code-insert",
              msg.tx,
              fixture.source.length,
              `INITIALIZED code owner ${patch.node.id} was inserted again by PATCH`,
            );
          }
        }
        for (const failure of verifyCodeWirePatches(
          msg.patches,
          prior,
          store,
          fullSource,
        )) {
          recordDivergence(
            divergences,
            fixture,
            plan,
            `initialized-root:${failure.stage}`,
            msg.tx,
            fixture.source.length,
            failure.message,
          );
        }
        return;
      }
      if (msg.type === "ERROR" || msg.type === "RESET") {
        recordDivergence(
          divergences,
          fixture,
          plan,
          `initialized-root:${msg.type.toLowerCase()}`,
          -1,
          0,
          msg.type === "ERROR" ? msg.error.message : msg.reason,
        );
      }
    },
  });

  try {
    await engine.handle({ ...PARITY_INIT, initialContent: fixture.source });
    if (initializationCount !== 1 || initializedGeneration === undefined) {
      recordDivergence(
        divergences,
        fixture,
        plan,
        "initialized-root:missing",
        initializationCount,
        0,
        `Expected one INITIALIZED root snapshot; observed ${initializationCount}`,
      );
      return divergences;
    }

    const blocks = store.getBlocks();
    const rootCodeBlocks = blocks.filter(
      (block) => block.type === "code" && store.getNode(block.id)?.parentId === PATCH_ROOT_ID,
    );
    if (rootCodeBlocks.length !== fixture.expectations?.codeBlocks?.length) {
      recordDivergence(
        divergences,
        fixture,
        plan,
        "initialized-root:code-owner-count",
        0,
        fixture.source.length,
        `INITIALIZED root code owners=${rootCodeBlocks.length} expected=${fixture.expectations?.codeBlocks?.length ?? 0}`,
      );
    }
    for (const block of rootCodeBlocks) {
      const codeView = store.getCodeBlock(block.id);
      if (!codeView) {
        recordDivergence(
          divergences,
          fixture,
          plan,
          "initialized-root:code-state",
          0,
          fixture.source.length,
          `INITIALIZED code owner ${block.id} has no prepared store view`,
        );
        continue;
      }
      if (
        codeView.source.codeOwnerId !== block.id ||
        codeView.source.generation !== initializedGeneration ||
        codeView.source.state !== "closed"
      ) {
        recordDivergence(
          divergences,
          fixture,
          plan,
          "initialized-root:code-state",
          0,
          fixture.source.length,
          `INITIALIZED code owner ${block.id} has mismatched owner/generation/state`,
        );
      }
      const { from, to } = codeView.source.sourceRange;
      if (
        block.payload.range?.from !== from ||
        block.payload.range?.to !== to ||
        block.payload.raw !== fixture.source.slice(from, to)
      ) {
        recordDivergence(
          divergences,
          fixture,
          plan,
          "initialized-root:authored-source",
          0,
          fixture.source.length,
          `INITIALIZED code owner ${block.id} did not cold-export its exact authored source range`,
        );
      }
      const expected = fixture.expectations?.codeBlocks?.find(
        (code) => code.lang === codeView.language,
      );
      if (expected) {
        const rows = store.getCodeLines(block.id, 0, codeView.source.lineCount);
        if (rows.length !== expected.codeLines.length) {
          recordDivergence(
            divergences,
            fixture,
            plan,
            "initialized-root:bounded-lines",
            0,
            fixture.source.length,
            `INITIALIZED code owner ${block.id} returned ${rows.length} rows; expected ${expected.codeLines.length}`,
          );
        } else {
          for (let index = 0; index < rows.length; index += 1) {
            const row = rows[index];
            const expectedText = expected.codeLines[index];
            const authoredLine = fixture.source.slice(row.sourceRange.from, row.sourceRange.to);
            const expectedAuthoredLine = `${" ".repeat(expected.openingFenceIndent ?? 0)}${expectedText}`;
            const authoredEnding = fixture.source.slice(
              row.sourceRange.to,
              row.sourceRange.to + row.ending.length,
            );
            if (
              row.text !== expectedText ||
              authoredLine !== expectedAuthoredLine ||
              authoredEnding !== row.ending
            ) {
              recordDivergence(
                divergences,
                fixture,
                plan,
                "initialized-root:authored-line",
                0,
                row.sourceRange.to,
                `INITIALIZED code owner ${block.id} line ${index} lost dedented text or authored source/ending`,
              );
              break;
            }
          }
        }
      }
    }

    const expectationResult = verifyIndependentExpectations(blocks, fixture, store);
    if (!expectationResult.ok) {
      recordDivergence(
        divergences,
        fixture,
        plan,
        "initialized-root:expectations",
        0,
        fixture.source.length,
        expectationResult.message ?? "CommonMark root-code expectation failed",
      );
    }
    const tokenResult = await verifyCompletedLineTokens(
      collectBlocksRecursively(blocks),
      highlighter,
      engine,
      store,
      fixture.source,
    );
    if (!tokenResult.ok) {
      recordDivergence(
        divergences,
        fixture,
        plan,
        "initialized-root:tokens",
        0,
        fixture.source.length,
        tokenResult.message ?? "INITIALIZED root-code token parity failed",
      );
    }

    const initialRowsByOwner = new Map<string, ReadonlyArray<CodeLineRecord>>();
    for (const block of rootCodeBlocks) {
      const view = store.getCodeBlock(block.id);
      if (view) initialRowsByOwner.set(block.id, store.getCodeLines(block.id, 0, view.source.lineCount));
    }
    await engine.handle({ type: "APPEND", text: followup });
    if (initializationCount !== 1) {
      recordDivergence(
        divergences,
        fixture,
        plan,
        "initialized-root:followup-reset",
        initializationCount,
        fixture.source.length,
        "Tail append promoted the existing initialized root code through a new snapshot generation",
      );
    }
    for (const block of rootCodeBlocks) {
      const view = store.getCodeBlock(block.id);
      const rows = view ? store.getCodeLines(block.id, 0, view.source.lineCount) : [];
      const initialRows = initialRowsByOwner.get(block.id) ?? [];
      if (
        !view ||
        view.source.generation !== initializedGeneration ||
        view.source.state !== "closed" ||
        rows.length !== initialRows.length ||
        rows.some((row, index) => row !== initialRows[index])
      ) {
        recordDivergence(
          divergences,
          fixture,
          plan,
          "initialized-root:followup-stability",
          patchTx,
          fixture.source.length,
          `Post-INITIALIZED tail append changed root code owner ${block.id}`,
        );
      }
    }
  } catch (error) {
    recordDivergence(
      divergences,
      fixture,
      plan,
      "initialized-root:exception",
      -1,
      -1,
      error instanceof Error ? error.stack ?? error.message : String(error),
    );
  } finally {
    engine.dispose();
  }
  return divergences;
}
