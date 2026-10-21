import {
  AppendSourceDocument,
  createBlockCompatibilityExtension,
  createBlockSnapshot,
  InlineParser,
  prepareNestedBlockSnapshotFromNative,
  PATCH_ROOT_ID,
  STREAM_MDX_SCHEMA_VERSION,
  type Block,
  type NodeSnapshot,
  type Patch,
  type WorkerOut,
} from "@stream-mdx/core";
import { GFM, parser as baseMarkdownParser } from "@lezer/markdown";

import assert from "node:assert";
import fs from "node:fs/promises";
import { createRendererStore } from "../../markdown-v2-react/src/renderer/store";
import { MarkdownBlocksRenderer } from "@stream-mdx/react/server";
import { JSDOM } from "jsdom";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NativeMarkdownInput } from "../src/engine/native-markdown-input";
import { HtmlContinuationExtension } from "../src/parser/html-extension";

import { createWorkerHarness } from "./worker-test-harness";

const DOC_PLUGINS = {
  footnotes: true,
  html: true,
  mdx: true,
  tables: true,
  callouts: true,
  math: true,
} as const;

const nativeParser = baseMarkdownParser.configure([
  GFM,
  createBlockCompatibilityExtension(),
  HtmlContinuationExtension,
]);

function flatten(snapshot: NodeSnapshot): NodeSnapshot[] {
  return [snapshot, ...(snapshot.children ?? []).flatMap(flatten)];
}

async function loadFixture(name: string): Promise<string> {
  return await fs.readFile(new URL(`../../../tests/regression/fixtures/${name}`, import.meta.url), "utf8");
}

function applyPatchMessages(store: ReturnType<typeof createRendererStore>, messages: WorkerOut[]): void {
  for (const message of messages) {
    if (message.type !== "PATCH") continue;
    store.applyPatches(message.patches as Patch[], { captureMetrics: false });
  }
}

async function streamFixture(
  content: string,
  chunkSize: number,
  options: { mdxCompileMode?: "server" | "worker" } = {},
): Promise<ReadonlyArray<Block>> {
  const harness = await createWorkerHarness();
  const store = createRendererStore();

  const initMessages = await harness.send({ type: "INIT", schemaVersion: STREAM_MDX_SCHEMA_VERSION, initialContent: "",
  prewarmLangs: [],
  docPlugins: DOC_PLUGINS,
  mdx: options.mdxCompileMode ? { compileMode: options.mdxCompileMode } : undefined, });
  const init = initMessages.find((msg): msg is Extract<WorkerOut, { type: "INITIALIZED" }> => msg.type === "INITIALIZED");
  assert.ok(init, "worker failed to initialize");
  store.resetSnapshot(init.snapshot);

  for (let index = 0; index < content.length; index += chunkSize) {
    const chunk = content.slice(index, index + chunkSize);
    const appendMessages = await harness.send({ type: "APPEND", text: chunk });
    applyPatchMessages(store, appendMessages);
  }

  const finalizeMessages = await harness.send({ type: "FINALIZE" });
  applyPatchMessages(store, finalizeMessages);
  return store.getBlocks();
}

async function runNativeCodeSourceOwnershipTest(): Promise<void> {
  const content = await loadFixture("code-huge.md");
  const codeFence = /```js\r?\n([\s\S]*?)\r?\n```/.exec(content);
  assert.ok(codeFence, "expected the authored JavaScript fence in the source fixture");
  const expectedCode = codeFence[1];
  const expectedLines = expectedCode.split(/\r\n|\r|\n/);
  const bodyStart = codeFence.index + codeFence[0].indexOf(expectedCode);
  const closingFenceStart = codeFence.index + codeFence[0].length - 3;
  const harness = await createWorkerHarness();
  const store = createRendererStore();

  const initMessages = await harness.send({ type: "INIT", schemaVersion: STREAM_MDX_SCHEMA_VERSION, initialContent: "",
  prewarmLangs: [],
  docPlugins: { ...DOC_PLUGINS, codeHighlighting: "final", outputMode: "html", lazyTokenization: { enabled: false } }, });
  const init = initMessages.find((msg): msg is Extract<WorkerOut, { type: "INITIALIZED" }> => msg.type === "INITIALIZED");
  assert.ok(init, "worker failed to initialize");
  store.resetSnapshot(init.snapshot);

  const assertNativeSourceMatchesFixture = (phase: string) => {
    const block = store.getBlocks().find((candidate) => candidate.type === "code");
    if (!block) return;
    const owner = store.getCodeBlock(block.id);
    assert.ok(owner, `${phase}: expected a native code owner`);
    const rows = store.getCodeLines(block.id, 0, owner.source.lineCount);
    assert.strictEqual(rows.length, owner.source.lineCount, `${phase}: source range must expose every owned code line`);
    const ownerRange = owner.source.sourceRange;
    assert.ok(
      rows.every((line) => ownerRange.from <= line.sourceRange.from && line.sourceRange.to <= ownerRange.to),
      `${phase}: source owner must bound every authored line record`,
    );
    for (const line of rows) {
      const { from, to } = line.sourceRange;
      assert.ok(
        from >= bodyStart && to + line.ending.length <= closingFenceStart,
        `${phase}: native line range must remain within the authored fence body`,
      );
      assert.strictEqual(content.slice(from, to), line.text, `${phase}: native line text must match authored source`);
      assert.strictEqual(content.slice(to, to + line.ending.length), line.ending, `${phase}: native line ending must match authored source`);
    }
  };

  for (let index = 0; index < content.length; index += 37) {
    const appendMessages = await harness.send({ type: "APPEND", text: content.slice(index, index + 37) });
    applyPatchMessages(store, appendMessages);
    assertNativeSourceMatchesFixture(`APPEND @${index}`);
    assert.deepStrictEqual(store.getInvariantViolations(), [], `renderer store must preserve source invariants during APPEND @${index}`);
  }

  const finalizeMessages = await harness.send({ type: "FINALIZE" });
  applyPatchMessages(store, finalizeMessages);
  assertNativeSourceMatchesFixture("FINALIZE");
  const codeBlock = store.getBlocks().find((candidate) => candidate.type === "code");
  assert.ok(codeBlock, "expected finalized native code block");
  const owner = store.getCodeBlock(codeBlock.id);
  assert.ok(owner);
  assert.strictEqual(owner.source.state, "finalized");
  const rows = store.getCodeLines(codeBlock.id, 0, owner.source.lineCount);
  assert.deepStrictEqual(rows.map((line) => line.text), expectedLines, "final source lines must preserve the entire authored fixture body");
  assert.deepStrictEqual(store.getInvariantViolations(), []);
}

async function runFinalizedTableShapeTest(): Promise<void> {
  const blocks = await streamFixture(await loadFixture("table-boundary.md"), 29);
  const table = blocks.find((block) => block.type === "table");
  assert.ok(table, "expected finalized table block");
  const meta = (table?.payload.meta ?? {}) as { header?: unknown[][]; rows?: unknown[][][] };
  const headerColumns = Array.isArray(meta.header) ? meta.header.length : 0;
  assert.ok(headerColumns > 0, "expected table header columns");
  const rows = Array.isArray(meta.rows) ? meta.rows : [];
  assert.ok(rows.length > 0, "expected finalized table body rows");
  rows.forEach((row, rowIndex) => {
    assert.strictEqual(row.length, headerColumns, `finalized table row ${rowIndex} width mismatch`);
  });
}



function hasMathInline(nodes: unknown): boolean {
  if (!Array.isArray(nodes)) return false;
  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;
    const kind = (node as { kind?: unknown }).kind;
    if (kind === "math-inline" || kind === "math-display") {
      return true;
    }
    if (hasMathInline((node as { children?: unknown }).children)) {
      return true;
    }
  }
  return false;
}

async function runCurrencyDoesNotTriggerStreamingMathTest(): Promise<void> {
  const content = await loadFixture("table-large.md");
  const harness = await createWorkerHarness();
  const store = createRendererStore();

  const initMessages = await harness.send({ type: "INIT", schemaVersion: STREAM_MDX_SCHEMA_VERSION, initialContent: "",
  prewarmLangs: [],
  docPlugins: DOC_PLUGINS, });
  const init = initMessages.find((msg): msg is Extract<WorkerOut, { type: "INITIALIZED" }> => msg.type === "INITIALIZED");
  assert.ok(init, "worker failed to initialize");
  store.resetSnapshot(init.snapshot);

  for (let index = 0; index < content.length; index += 34) {
    const appendMessages = await harness.send({ type: "APPEND", text: content.slice(index, index + 34) });
    applyPatchMessages(store, appendMessages);
    const provisionalParagraphs = store
      .getBlocks()
      .filter((block) => block.type === "paragraph" && !block.isFinalized && typeof block.payload.raw === "string");
    for (const block of provisionalParagraphs) {
      const raw = block.payload.raw as string;
      if (!raw.includes("$")) continue;
      assert.ok(!hasMathInline(block.payload.inline), `currency-like streaming paragraph must not produce math nodes: ${raw}`);
      const ranges = Array.isArray((block.payload.meta as { protectedRanges?: unknown } | undefined)?.protectedRanges)
        ? (((block.payload.meta as { protectedRanges?: unknown }).protectedRanges as Array<{ kind?: unknown }>) ?? [])
        : [];
      assert.ok(
        !ranges.some((range) => range?.kind === "math-inline"),
        `currency-like streaming paragraph must not carry inline math protected ranges: ${raw}`,
      );
    }
  }
}

async function runFinalizedMdxStateTest(): Promise<void> {
  const cases: Array<{ fixture: string; chunkSize: number }> = [
    { fixture: "mdx-transitions.mdx", chunkSize: 31 },
    { fixture: "mdx-transitions.mdx", chunkSize: 5 },
    { fixture: "mdx-multi-status.mdx", chunkSize: 10 },
    { fixture: "mdx-multi-status.mdx", chunkSize: 24 },
  ];

  for (const { fixture, chunkSize } of cases) {
    const content = await loadFixture(fixture);
    const authoredMdxRanges = Array.from(
      content.matchAll(/<Preview\b[\s\S]*?<\/Preview>/g),
      (match) => ({ from: match.index, to: match.index + match[0].length }),
    );
    assert.ok(authoredMdxRanges.length > 0, `expected authored MDX components in ${fixture}`);

    const harness = await createWorkerHarness();
    const store = createRendererStore();
    const workerErrors: string[] = [];
    const consume = (messages: WorkerOut[]) => {
      for (const message of messages) {
        if (message.type === "ERROR") workerErrors.push(`${message.phase}: ${JSON.stringify(message.error)}`);
      }
      applyPatchMessages(store, messages);
    };

    const initMessages = await harness.send({ type: "INIT", schemaVersion: STREAM_MDX_SCHEMA_VERSION, initialContent: "",
    prewarmLangs: [],
    docPlugins: DOC_PLUGINS,
    mdx: { compileMode: "worker" }, });
    const init = initMessages.find((msg): msg is Extract<WorkerOut, { type: "INITIALIZED" }> => msg.type === "INITIALIZED");
    assert.ok(init, "worker failed to initialize");
    store.resetSnapshot(init.snapshot);
    consume(initMessages);

    for (let index = 0; index < content.length; index += chunkSize) {
      consume(await harness.send({ type: "APPEND", text: content.slice(index, index + chunkSize) }));
    }
    consume(await harness.send({ type: "FINALIZE" }));
    assert.deepStrictEqual(workerErrors, [], `worker must preserve paragraph leases through MDX finalization for ${fixture} @${chunkSize}`);

    const blocks = store.getBlocks();
    const rootRanges = blocks.flatMap((block) => {
      const range = block.payload.range;
      return range ? [{ block, range }] : [];
    });
    for (let index = 1; index < rootRanges.length; index += 1) {
      const previous = rootRanges[index - 1]!;
      const current = rootRanges[index]!;
      assert.ok(
        previous.range.from <= current.range.from,
        `root blocks must remain in authored source order: ${previous.block.id} then ${current.block.id}`,
      );
      assert.ok(
        previous.range.to <= current.range.from,
        `root source ranges must not overlap: ${previous.block.id} then ${current.block.id}`,
      );
    }
    const snapshots = blocks.flatMap((block) => flatten(createBlockSnapshot(block)));
    const paragraphOwners = snapshots.filter((snapshot) => snapshot.paragraph !== undefined);
    assert.ok(paragraphOwners.length > 0, `fixture must retain native paragraph owners through finalization: ${fixture} @${chunkSize}`);
    for (const snapshot of paragraphOwners) {
      assert.strictEqual(snapshot.paragraph?.state, "finalized", `native paragraph owner must finalize: ${snapshot.id}`);
    }
    const mdxRanges: Array<{ readonly from: number; readonly to: number }> = [];
    const mdxBlocks = blocks.filter((block) => block.type === "mdx");
    for (const block of mdxBlocks) {
      assert.ok(block.isFinalized, `mdx block must be finalized: ${block.id}`);
      const range = block.payload.range;
      assert.ok(range, `mdx block must retain its authored source range: ${block.id}`);
      assert.strictEqual(
        content.slice(range.from, range.to),
        block.payload.raw,
        `mdx block source must match its authored range: ${block.id}`,
      );
      mdxRanges.push(range);
      const meta = block.payload.meta;
      const status = meta && typeof meta === "object" && "mdxStatus" in meta && typeof meta.mdxStatus === "string" ? meta.mdxStatus : undefined;
      assert.ok(status === "compiled" || status === "error", `finalized mdx block must have a terminal compilation state: ${block.id}`);
      if (status === "compiled") {
        assert.ok(block.payload.compiledMdxRef || block.payload.compiledMdxModule, `compiled mdx block missing artifact: ${block.id}`);
      }
      if (status === "error") {
        assert.strictEqual(block.payload.compiledMdxRef, undefined, `errored mdx block retained compiledMdxRef: ${block.id}`);
        assert.strictEqual(block.payload.compiledMdxModule, undefined, `errored mdx block retained compiledMdxModule: ${block.id}`);
      }
      if (block.payload.compiledMdxRef && block.payload.compiledMdxModule) {
        assert.strictEqual(
          block.payload.compiledMdxRef.id,
          block.payload.compiledMdxModule.id,
          `compiled mdx ids must agree for ${block.id}`,
        );
      }
    }

    for (const snapshot of snapshots) {
      if (snapshot.type !== "paragraph-mdx") continue;
      const range = snapshot.range;
      assert.ok(range, `paragraph MDX segment must retain its authored source range: ${snapshot.id}`);
      const raw = snapshot.props?.raw;
      assert.strictEqual(
        content.slice(range.from, range.to),
        raw,
        `paragraph MDX segment source must match its authored range: ${snapshot.id}`,
      );
      mdxRanges.push(range);
    }
    mdxRanges.sort((left, right) => left.from - right.from || left.to - right.to);
    for (let index = 0; index < authoredMdxRanges.length; index += 1) {
      const authored = authoredMdxRanges[index]!;
      let coveredTo = authored.from;
      for (const range of mdxRanges) {
        if (range.to <= coveredTo) continue;
        if (range.from > coveredTo) break;
        coveredTo = Math.max(coveredTo, range.to);
        if (coveredTo >= authored.to) break;
      }
      assert.ok(coveredTo >= authored.to, `authored MDX component ${index} must remain in typed MDX source projections in ${fixture} @${chunkSize}`);
    }

  }
}

async function runMdxTransitionsRendererStoreInvariantTest(): Promise<void> {
  const content = await loadFixture("mdx-transitions.mdx");
  const authoredCode = Array.from(content.matchAll(/```text\r?\n([\s\S]*?)\r?\n```/g), (match) => {
    const from = match.index + match[0].indexOf(match[1]);
    return {
      from,
      closingFenceFrom: match.index + match[0].length - 3,
      text: match[1],
    };
  });
  const harness = await createWorkerHarness();
  const store = createRendererStore();

  const initMessages = await harness.send({ type: "INIT", schemaVersion: STREAM_MDX_SCHEMA_VERSION, initialContent: "",
  prewarmLangs: [],
  docPlugins: DOC_PLUGINS,
  mdx: { compileMode: "worker" }, });
  const init = initMessages.find((msg): msg is Extract<WorkerOut, { type: "INITIALIZED" }> => msg.type === "INITIALIZED");
  assert.ok(init, "worker failed to initialize");
  store.resetSnapshot(init.snapshot);

  const assertCodeSourcesMatchAuthoredRanges = (phase: string) => {
    for (const block of store.getBlocks().filter((candidate) => candidate.type === "code")) {
      const owner = store.getCodeBlock(block.id);
      assert.ok(owner, `${phase}: expected a native code owner for ${block.id}`);
      const ownerRange = owner.source.sourceRange;
      const rows = store.getCodeLines(block.id, 0, owner.source.lineCount);
      assert.strictEqual(rows.length, owner.source.lineCount, `${phase}: native source range must expose each line`);
      assert.ok(
        rows.every((line) => ownerRange.from <= line.sourceRange.from && line.sourceRange.to <= ownerRange.to),
        `${phase}: native code owner must bound its line records`,
      );
      for (const line of rows) {
        const { from, to } = line.sourceRange;
        assert.ok(
          authoredCode.some((range) => from >= range.from && to + line.ending.length <= range.closingFenceFrom),
          `${phase}: native line range must remain within an authored code body`,
        );
        assert.strictEqual(content.slice(from, to), line.text, `${phase}: native line must preserve authored source text`);
        assert.strictEqual(
          content.slice(to, to + line.ending.length),
          line.ending,
          `${phase}: native line must preserve its authored line ending`,
        );
      }
    }
  };

  for (let index = 0; index < content.length; index += 31) {
    const appendMessages = await harness.send({ type: "APPEND", text: content.slice(index, index + 31) });
    applyPatchMessages(store, appendMessages);
    assertCodeSourcesMatchAuthoredRanges(`APPEND @${index}`);
    assert.deepStrictEqual(store.getInvariantViolations(), [], `renderer store must preserve all invariants during MDX transition chunk @${index}`);
  }

  const finalizeMessages = await harness.send({ type: "FINALIZE" });
  applyPatchMessages(store, finalizeMessages);
  assertCodeSourcesMatchAuthoredRanges("FINALIZE");
  const codeBlocks = store.getBlocks().filter((block) => block.type === "code");
  const finalizedSourceLines = codeBlocks.map((block, index) => {
    const owner = store.getCodeBlock(block.id);
    assert.ok(owner, `finalized code fence ${index} must retain its native owner`);
    assert.strictEqual(owner.source.state, "finalized");
    return store.getCodeLines(block.id, 0, owner.source.lineCount).map((line) => line.text);
  });
  assert.deepStrictEqual(
    finalizedSourceLines,
    authoredCode.map((fence) => fence.text.split(/\r\n|\r|\n/)),
    "every authored code fence must retain its finalized native source lines",
  );
  assert.deepStrictEqual(store.getInvariantViolations(), [], "renderer store must preserve all invariants through MDX transition finalization");
}

async function runMdxErrorTransitionArtifactInvariantTest(): Promise<void> {
  const loggedErrors: string[] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    loggedErrors.push(args.map(String).join(" "));
    originalConsoleError(...args);
  };

  const getMdxStatus = (block: Block): string | undefined => {
    const meta = block.payload.meta;
    if (meta && typeof meta === "object" && "mdxStatus" in meta && typeof meta.mdxStatus === "string") {
      return meta.mdxStatus;
    }
    return undefined;
  };

  const assertBlockPayloadNoArtifactsOnError = (candidate: unknown, source: string) => {
    if (!candidate || typeof candidate !== "object") return;
    if (!("type" in candidate) || candidate.type !== "mdx" || !("payload" in candidate)) return;
    const block = candidate as Block;
    const status = getMdxStatus(block);
    if (status === "error") {
      assert.strictEqual(
        block.payload.compiledMdxRef,
        undefined,
        `${source} errored mdx block must not retain compiledMdxRef: ${block.id}`,
      );
      assert.strictEqual(
        block.payload.compiledMdxModule,
        undefined,
        `${source} errored mdx block must not retain compiledMdxModule: ${block.id}`,
      );
    }
  };

  try {
    // Unclosed components are pending, not compilation errors. Exercise genuine failures in
    // closed module-owned MDX, and identify each malformed source rather than incidental errors.
    const malformedTransitionRaw = "<PreviewExample>\n{1 + }\n</PreviewExample>";
    const malformedStatusRaw = "<Preview count={}>\nThis block should fail compilation and render the MDX error state.\n</Preview>";
    const cases: Array<{ fixture: string; content: string; chunkSize: number; malformedRaw: string }> = [
      { fixture: "mdx-multi-status.mdx", content: await loadFixture("mdx-multi-status.mdx"), chunkSize: 10, malformedRaw: malformedStatusRaw },
      { fixture: "mdx-transitions.mdx", content: `${await loadFixture("mdx-transitions.mdx")}\n\n${malformedTransitionRaw}\n`, chunkSize: 5, malformedRaw: malformedTransitionRaw },
    ];

    for (const { fixture, content, chunkSize, malformedRaw } of cases) {
      const harness = await createWorkerHarness();
      const store = createRendererStore();

      const initMessages = await harness.send({ type: "INIT", schemaVersion: STREAM_MDX_SCHEMA_VERSION, initialContent: "",
      prewarmLangs: [],
      docPlugins: DOC_PLUGINS,
      mdx: { compileMode: "worker" }, });
      const init = initMessages.find((msg): msg is Extract<WorkerOut, { type: "INITIALIZED" }> => msg.type === "INITIALIZED");
      assert.ok(init, "worker failed to initialize");
      store.resetSnapshot(init.snapshot);

      for (let index = 0; index < content.length; index += chunkSize) {
        const chunk = content.slice(index, index + chunkSize);
        const appendMessages = await harness.send({ type: "APPEND", text: chunk });
        for (const message of appendMessages) {
          if (message.type !== "PATCH") continue;
          const patches = message.patches as Patch[];
          for (const patch of patches) {
            if (patch.op === "setProps" && patch.props && typeof patch.props === "object" && "block" in patch.props) {
              assertBlockPayloadNoArtifactsOnError(patch.props.block, `patch setProps @${index}`);
            } else if ((patch.op === "insertChild" || patch.op === "replaceChild") && patch.node?.props && typeof patch.node.props === "object" && "block" in patch.node.props) {
              assertBlockPayloadNoArtifactsOnError(patch.node.props.block, `patch ${patch.op} @${index}`);
            }
          }
          store.applyPatches(patches, { captureMetrics: false });
        }
      }

      const finalizeMessages = await harness.send({ type: "FINALIZE" });
      for (const message of finalizeMessages) {
        if (message.type !== "PATCH") continue;
        const patches = message.patches as Patch[];
        for (const patch of patches) {
          if (patch.op === "setProps" && patch.props && typeof patch.props === "object" && "block" in patch.props) {
            assertBlockPayloadNoArtifactsOnError(patch.props.block, "finalize patch setProps");
          } else if ((patch.op === "insertChild" || patch.op === "replaceChild") && patch.node?.props && typeof patch.node.props === "object" && "block" in patch.node.props) {
            assertBlockPayloadNoArtifactsOnError(patch.node.props.block, `finalize patch ${patch.op}`);
          }
        }
        store.applyPatches(patches, { captureMetrics: false });
      }

      const consumerBlocks = store.getBlocks();
      const erroredMdxBlocks = consumerBlocks.filter(
        (b) => b.type === "mdx" && getMdxStatus(b) === "error",
      );
      const malformedBlock = consumerBlocks.find((block) => block.payload.raw.trim() === malformedRaw);
      assert.ok(malformedBlock, `missing owned malformed MDX source in ${fixture}`);
      assert.strictEqual(malformedBlock.type, "mdx", `closed malformed source must retain module ownership in ${fixture}`);
      assert.strictEqual(getMdxStatus(malformedBlock), "error", `closed malformed source must fail compilation in ${fixture}`);
      for (const errorBlock of erroredMdxBlocks) {
        assert.strictEqual(
          errorBlock.payload.compiledMdxRef,
          undefined,
          `consumer store errored block must not retain compiledMdxRef: ${errorBlock.id}`,
        );
        assert.strictEqual(
          errorBlock.payload.compiledMdxModule,
          undefined,
          `consumer store errored block must not retain compiledMdxModule: ${errorBlock.id}`,
        );
      }
    }

    const invariantViolations = loggedErrors.filter((msg) => msg.includes("Structural invariant violation"));
    assert.deepStrictEqual(invariantViolations, [], "worker emitted structural invariant violation during MDX error transitions");
  } finally {
    console.error = originalConsoleError;
  }
}


async function runNativeNestedSnapshotMappingTest(): Promise<void> {
  const nativeNestedSourceText = [
    "lead 😀",
    "> **Quoted paragraph**",
    "> continuation",
    ">",
    "> Authored space\u0020",
    "> after",
    ">",
    "> 3. [x] item",
    ">",
    ">    list paragraph",
    ">    continuation",
    ">",
    ">    | Name | Count |",
    ">    | :--- | ---: |",
    ">    | alpha | 2 |",
    "",
  ].join("\r\n");
  const nativeNestedDocument = new AppendSourceDocument();
  nativeNestedDocument.append(nativeNestedSourceText);
  const nativeNestedSource = nativeNestedDocument.snapshot();
  const nativeNestedInput = new NativeMarkdownInput(nativeNestedSource);
  const nativeNestedTree = nativeNestedInput.parse(nativeParser);
  let nativeQuote = nativeNestedTree.topNode.firstChild;
  while (nativeQuote && nativeQuote.type.name !== "Blockquote") nativeQuote = nativeQuote.nextSibling;
  assert.ok(nativeQuote, "canonical native parsing must preserve the quoted container");
  const nativeNestedBlock: Block = {
    id: "direct-native-container",
    type: "blockquote",
    isFinalized: true,
    payload: {
      raw: "",
      range: { from: nativeQuote.from, to: nativeQuote.to },
    },
  };
  const nativeNestedPrepared = prepareNestedBlockSnapshotFromNative(
    nativeNestedBlock,
    nativeQuote,
    {
      input: nativeNestedInput,
      source: nativeNestedSource,
      mapOffset: (offset) => offset,
      mapRange: (from, to) => ({ from, to }),
    },
    new InlineParser(),
    nativeParser,
  );
  nativeNestedBlock.payload.meta = { preparedNested: nativeNestedPrepared };
  const nativeNestedNodes = flatten(createBlockSnapshot(nativeNestedBlock));
  const nativeParagraph = nativeNestedNodes.find((node) =>
    node.type === "paragraph" && String(node.props?.text).includes("Quoted paragraph"));
  assert.ok(nativeParagraph, "native lowering must retain the quoted paragraph");
  assert.equal(
    String(nativeParagraph.props?.text).replace(/\r\n/g, "\n"),
    "Quoted paragraph\ncontinuation",
    "native quoted paragraph meaning must exclude CRLF artifacts",
  );
  const nativeParagraphBlock = nativeParagraph.props?.block as Block;
  const nativeParagraphRange = nativeParagraphBlock.payload.range!;
  assert.equal(
    nativeParagraphBlock.payload.raw,
    nativeNestedSource.read(nativeParagraphRange.from, nativeParagraphRange.to),
    "native paragraph raw must equal its physical UTF-16 source range",
  );
  assert.ok(nativeParagraphBlock.payload.raw.includes("**Quoted paragraph**"), "native paragraph source must retain authored emphasis");
  const nativeAuthoredSpaceParagraph = nativeNestedNodes.find((node) =>
    node.type === "paragraph" && String(node.props?.text).includes("Authored space"));
  assert.ok(nativeAuthoredSpaceParagraph, "native lowering must retain the authored-space paragraph");
  assert.equal(
    String(nativeAuthoredSpaceParagraph.props?.text),
    "Authored space \nafter",
    "native semantic projection must preserve authored spaces while excluding CRLF artifacts",
  );
  const nativeAuthoredSpaceBlock = nativeAuthoredSpaceParagraph.props?.block as Block;
  assert.ok(
    nativeAuthoredSpaceBlock.payload.raw.includes("Authored space \r\n"),
    "native physical paragraph source must retain authored space and CRLF",
  );

  const nativeList = nativeNestedNodes.find((node) => node.type === "list");
  assert.ok(nativeList, "native lowering must retain the nested ordered list");
  assert.equal(nativeList.props?.ordered, true, "quoted list must remain ordered");
  assert.equal(nativeList.props?.start, 3, "quoted ordered list must retain its authored start");
  assert.equal(nativeList.props?.loose, true, "quoted list must retain loose-list meaning");
  const nativeTaskItem = nativeList.children?.find((node) => node.type === "list-item");
  assert.ok(nativeTaskItem, "native lowering must retain the task list item");
  assert.equal(nativeTaskItem.props?.task, true, "quoted list item must retain task semantics");
  assert.equal(nativeTaskItem.props?.checked, true, "quoted task item must retain its checked state");
  assert.equal(nativeTaskItem.props?.text, "item", "quoted task item text must exclude its task marker");
  assert.equal(nativeTaskItem.children?.some((node) => node.type === "table"), true, "quoted task item must retain its nested typed table");
  const nativeListParagraph = nativeTaskItem.children?.find((node) => node.type === "paragraph");
  assert.ok(nativeListParagraph, "native lowering must retain the list paragraph");
  assert.equal(
    String(nativeListParagraph.props?.text).replace(/\r\n/g, "\n"),
    "list paragraph\ncontinuation",
    "native list paragraph meaning must exclude CRLF artifacts",
  );
  const nativeListParagraphBlock = nativeListParagraph.props?.block as Block;
  const nativeListParagraphRange = nativeListParagraphBlock.payload.range!;
  assert.equal(
    nativeListParagraphBlock.payload.raw,
    nativeNestedSource.read(nativeListParagraphRange.from, nativeListParagraphRange.to),
    "native list paragraph raw must equal its physical UTF-16 source range",
  );
  assert.ok(nativeListParagraphBlock.payload.raw.includes("\r\n"), "native list paragraph raw must retain authored CRLF");
  assert.notEqual(nativeListParagraphBlock.payload.raw, nativeListParagraph.props?.text, "physical source must remain distinct from rendered text");

  const nativeTable = nativeNestedNodes.find((node) => node.type === "table");
  assert.ok(nativeTable, "native lowering must retain the nested typed table");
  assert.deepEqual(
    (nativeTable.props?.block as Block).payload.meta?.align,
    ["left", "right"],
    "native table alignment must preserve authored column alignment",
  );
  const nativeTableHeader = nativeTable.children?.find((node) => node.type === "table-header");
  assert.deepEqual(
    nativeTableHeader?.children?.map((cell) => cell.props?.text),
    ["Name", "Count"],
    "native table header must preserve both typed cell values",
  );
  const nativeTableRows = nativeTable.children?.find((node) => node.type === "table-body")?.children;
  assert.deepEqual(
    nativeTableRows?.[0]?.children?.map((cell) => cell.props?.text),
    ["alpha", "2"],
    "native table body must preserve typed row cell values",
  );
}
async function runNativeHtmlFamilyScopeTest(): Promise<void> {
  const chunks = [
    '<div title="Native scope">\n\n| Name | Value |\n| --- | --- |\n',
    "| alpha | one |\n",
    "| beta | two |\n\nParagraph **inside**.\n",
    "\n</div>\n",
  ];
  const source = chunks.join("");
  const harness = await createWorkerHarness();
  const store = createRendererStore();
  const initialized = await harness.send({
    type: "INIT",
    schemaVersion: STREAM_MDX_SCHEMA_VERSION,
    initialContent: "",
    prewarmLangs: [],
    docPlugins: { html: true, tables: true, mdx: false, math: false, callouts: false, footnotes: false },
  });
  const init = initialized.find((message): message is Extract<WorkerOut, { type: "INITIALIZED" }> =>
    message.type === "INITIALIZED");
  assert.ok(init, "HTML family consumer requires an actual worker baseline");
  store.resetSnapshot(init.snapshot);

  const assertNativeFamilies = () => {
    const descendants = (id: string): string[] => [id, ...store.getChildren(id).flatMap(descendants)];
    const nodeIds = store.getChildren(PATCH_ROOT_ID).flatMap(descendants);
    const table = nodeIds.map((id) => store.getTableBlock(id)).find((view) =>
      view?.source.sourceRange.from === source.indexOf("| Name"));
    assert.ok(table, "HTML admission must retain the typed table owner");
    assert.equal(table.source.rowCount, 2, "the native table must retain both authored rows");
    const paragraph = nodeIds.map((id) => store.getParagraphBlock(id)).find((view) =>
      view?.source.sourceRange.from === source.indexOf("Paragraph"));
    assert.ok(paragraph, "HTML admission must retain the typed paragraph owner");
    assert.equal(
      paragraph.source.sourceRange.to,
      source.indexOf("Paragraph") + "Paragraph **inside**.".length,
      "native paragraph ownership must preserve the authored inline source range",
    );
  };
  const assertRenderedMeaning = (requireHtmlScope: boolean) => {
    const html = renderToStaticMarkup(createElement(MarkdownBlocksRenderer, { blocks: store.getBlocks(), store }));
    const dom = new JSDOM(html);
    try {
      const document = dom.window.document;
      const rows = (parent: ParentNode) => [...parent.querySelectorAll("tbody tr")].map((row) =>
        [...row.querySelectorAll("td")].map((cell) => cell.textContent));
      const expectedRows = [["alpha", "one"], ["beta", "two"]];
      assert.deepEqual(rows(document), expectedRows, "native table rendering must neither lose nor duplicate rows");
      if (requireHtmlScope) {
        const scope = document.querySelector('div[title="Native scope"]');
        assert.ok(scope, "authored HTML scope must survive finalization");
        assert.deepEqual(rows(scope), expectedRows, "the table must render inside its authored HTML scope");
        const paragraph = scope.querySelector("p");
        assert.equal(paragraph?.textContent, "Paragraph inside.", "the paragraph must render in its authored HTML scope");
        assert.equal(paragraph?.querySelector("strong")?.textContent, "inside", "HTML adoption must retain inline meaning");
      }
    } finally {
      dom.window.close();
    }
  };

  for (const text of chunks) {
    applyPatchMessages(store, await harness.send({ type: "APPEND", text }));
    assert.deepEqual(store.getInvariantViolations(), [], "HTML append must preserve native ownership guards");
  }
  assertNativeFamilies();
  assertRenderedMeaning(false);
  const finalized = await harness.send({ type: "FINALIZE" });
  applyPatchMessages(store, finalized);
  assert.deepEqual(store.getInvariantViolations(), [], "HTML finalization must preserve native ownership guards");
  assert.ok(finalized.some((message) => message.type === "FINALIZED"), "HTML family consumer requires actual completion");
  assertNativeFamilies();
  assertRenderedMeaning(true);
}

await runNativeNestedSnapshotMappingTest();
await runNativeCodeSourceOwnershipTest();
await runCurrencyDoesNotTriggerStreamingMathTest();
await runFinalizedTableShapeTest();
await runFinalizedMdxStateTest();
await runMdxTransitionsRendererStoreInvariantTest();
await runMdxErrorTransitionArtifactInvariantTest();
await runNativeHtmlFamilyScopeTest();
console.log("worker structural regressions test passed");
