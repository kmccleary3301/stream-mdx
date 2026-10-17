import assert from "node:assert/strict";
import React, { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import type { Block } from "@stream-mdx/core";
import { compileTrustedMdxDocument } from "@stream-mdx/worker/mdx-compile";
import { projectTrustedMdxServerDocument } from "../src/trusted-mdx/server";
import { TrustedMdxNativeChildrenSlot } from "@stream-mdx/react/_internal/trusted-mdx-native-children";
import type { TrustedMdxEngine } from "../src/trusted-mdx-contract";
import { StreamingMarkdown, type StreamingMarkdownHandle } from "../src/streaming-markdown";
import type { CodeFenceRendererProps } from "../src/types";
import {
  RetainedFrameRenderFailureContext,
  TrustedDocumentProjection,
  deferred,
  features,
  installTrustedNativeTestDom,
  makeEngine,
  nativeTableElements,
  trustedOwners,
  waitFor,
  workerFactory,
} from "./trusted-native-fixture";
import type { Deferred } from "./trusted-native-fixture";

const restoreTrustedNativeTestDom = installTrustedNativeTestDom();

function wholeDocumentSource(value: string): string {
  return [
    'import { Card } from "host:widgets";',
    'export const sharedValue = "shared lexical scope";',
    'export default function Layout({ children }) {',
    '  return <section data-document-layout="true">{children}</section>;',
    '}',
    "",
    `# Native heading 🧭 **before {${value}} after**`,
    "",
    "```js",
    "const nativeCode = 7;",
    "```",
    "",
    '<Card value="flow" />',
    "",
    '<Card value="native-panel">',
    "",
    "## Prepared child heading",
    `Prepared paragraph before <Card value={${value}} /> after.`,
    "",
    "",
    "```js",
    "const preparedChild = 11;",
    "```",
    "",
    "| Native | row |",
    "| --- | --- |",
    "| owner | prepared |",
    "",
    "</Card>",
    "",
    "",

    "",
    "<>",
    "",
    `Fragment paragraph before <Card value={${value}} /> after.`,
    "",
    '<Card value="fragment-panel">',
    "",
    "## Fragment prepared child heading",
    "",
    "```js",
    "const fragmentPreparedChild = 19;",
    "```",
    "",
    "| Fragment | row |",
    "| --- | --- |",
    "| owner | fragment |",
    "",
    "</Card>",
    "",
    "</>",
    "",
    `Native paragraph **before {${value}} after** and \\{literal\\}, with \`{inlineCode}\`. Then <Card value={${value}} /> after, and **{"punctuation *stays* literal"}**.`,
    "",
    `> **Quote &amp; before <Card
>   value={${value}}
>   title="quote *punctuation* entity"
> /> after.**`,
    "",
    `- *List &amp; before <Card
  value={${value}}
  title="list *punctuation* entity"
  /> after.*`,
    "",
    "| Area | Result |",
    "| --- | --- |",
    `| Table | before <Card value={${value}} /> after |`,
  ].join("\n");
}

async function testActualWholeDocumentProjectionAndIndependentConsumers(): Promise<void> {
  const Card: React.FC<{ value?: string; title?: string; children?: React.ReactNode }> = ({ value, title, children }) => {
    if (value === "boom") throw new Error("candidate render failed");
    if (value === "native-panel" || value === "fragment-panel") {
      return <section data-trusted-card="true" data-card-value={value} data-card-title={title}>{children}</section>;
    }
    if (value === "flow") {
      return <aside data-trusted-card="true" data-card-value={value} data-card-title={title}>{value}</aside>;
    }
    return <span data-trusted-card="true" data-card-value={value} data-card-title={title}>{value}</span>;
  };
  const source = wholeDocumentSource("sharedValue");
  const engine = makeEngine(Card);
  const firstContainer = document.createElement("div");
  const secondContainer = document.createElement("div");
  document.body.append(firstContainer, secondContainer);
  const firstRoot = createRoot(firstContainer);
  const secondRoot = createRoot(secondContainer);
  const secondHandle = createRef<StreamingMarkdownHandle>();
  let firstUnmounted = false;

  try {
    await act(async () => {
      firstRoot.render(
        <React.StrictMode>
          <StreamingMarkdown
            engine="worker"
            worker={workerFactory}
            contentPolicy="trusted-mdx"
            engines={{ mdx: engine }}
            features={features}
            tableElements={nativeTableElements}
            text={source}
            caret={false}
          />
        </React.StrictMode>,
      );
      secondRoot.render(
        <StreamingMarkdown
          ref={secondHandle}
          engine="worker"
          worker={workerFactory}
          contentPolicy="trusted-mdx"
          engines={{ mdx: engine }}
          features={features}
          tableElements={nativeTableElements}
          text={source}
          caret={false}
        />,
      );
    });

    await waitFor(
      () => firstContainer.querySelector("[data-trusted-card]") !== null && secondContainer.querySelector("[data-trusted-card]") !== null,
      "real worker and compiler project both mounted document regions",
    );

    const workerBlocks = secondHandle.current?.getState().blocks;
    assert.ok(workerBlocks, "the server projection uses the exact completed worker revision");
    const serverProjection = await projectTrustedMdxServerDocument({
      source,
      blocks: workerBlocks,
      artifact: await compileTrustedMdxDocument(source),
      imports: { "host:widgets": { Card } },
    });
    const serverRegions = serverProjection.regions.filter(
      (region): region is (typeof serverProjection.regions)[number] & { readonly kind: "render" } =>
        region.kind === "render",
    );
    assert.ok(serverRegions.length > 0);
    for (const region of serverRegions) {
      assert.ok(React.isValidElement(region.content), "server handoff carries React content nodes");
      assert.equal("regions" in region, false, "evaluated region closures never enter client region data");
      assert.equal("components" in region, false, "host component maps never enter client region data");
    }
    const preparedPanel = serverRegions.find((region) => region.kind === "render" && region.nativeChildren);
    assert.ok(preparedPanel, "server projection marks the exact flow owner with worker-prepared native children");
    const panelContent = preparedPanel.content as React.ReactElement<{ children?: React.ReactNode }>;
    const [regionWrapper] = React.Children.toArray(panelContent.props.children);
    assert.ok(React.isValidElement<{ children?: React.ReactNode }>(regionWrapper));
    const regionWrapperElement = regionWrapper as React.ReactElement<{ children?: React.ReactNode }>;
    const flowRoot = React.Children.toArray(regionWrapperElement.props.children)[0];
    assert.ok(React.isValidElement<{ children?: React.ReactNode }>(flowRoot));
    const flowRootElement = flowRoot as React.ReactElement<{ children?: React.ReactNode }>;
    const nativeSlot = flowRootElement.props.children;
    assert.ok(React.isValidElement(nativeSlot));
    assert.equal((nativeSlot as React.ReactElement).type, TrustedMdxNativeChildrenSlot, "native children cross the server boundary through a private client slot");

    for (const container of [firstContainer, secondContainer]) {
      assert.equal(container.querySelectorAll("[data-trusted-card]").length, 9, "flow, nested flow, fragment native children, paragraph, quote, list, and table leaves use the full document module");
      assert.equal(container.textContent?.includes("host:widgets"), false, "successfully compiled ESM declarations do not become native Markdown output");
      assert.ok(container.querySelector("h1"), "the authored heading remains a native heading");
      assert.equal(
        container.querySelector("h1 strong")?.textContent,
        "before shared lexical scope after",
        "a trusted expression stays inside its native heading formatting",
      );
      const paragraph = Array.from(container.querySelectorAll("p")).find((item) => item.textContent?.includes("Native paragraph"));
      const flowCard = container.querySelector('[data-card-value="flow"]');
      assert.equal(flowCard?.tagName, "ASIDE", "compiler-classified flow JSX renders its native host result");
      assert.equal(flowCard?.closest("p"), null, "flow JSX has no native paragraph ancestor");
      const panel = container.querySelector('section[data-card-value="native-panel"]');
      assert.equal(panel?.querySelector("h2")?.textContent, "Prepared child heading", "flow JSX keeps worker-prepared native heading children");
      assert.equal(panel?.querySelector("pre code")?.textContent, "const preparedChild = 11;", "flow JSX keeps the worker-prepared code owner");
      assert.ok(panel?.querySelector("[data-native-table-wrapper]"), "flow JSX children use the native table element override");
      assert.deepEqual(
        Array.from(panel?.querySelectorAll("tbody tr") ?? [], (row) =>
          Array.from(row.querySelectorAll("td"), (cell) => cell.textContent),
        ),
        [["owner", "prepared"]],
        "flow JSX preserves the worker-owned native table row",
      );
      const fragmentParagraph = Array.from(container.querySelectorAll("p")).find((item) => item.textContent?.includes("Fragment paragraph"));
      assert.equal(
        fragmentParagraph?.textContent,
        "Fragment paragraph before shared lexical scope after.",
        "a compiler-owned fragment preserves its native Markdown paragraph child",
      );
      assert.equal(
        fragmentParagraph?.querySelector('[data-card-value="shared lexical scope"]')?.tagName,
        "SPAN",
        "inline JSX inside a fragment's prepared native paragraph remains inline",
      );
      const fragmentPanel = container.querySelector('section[data-card-value="fragment-panel"]');
      assert.equal(fragmentPanel?.closest("p"), null, "fragment flow JSX is not nested in a native paragraph");
      assert.equal(fragmentPanel?.querySelector("h2")?.textContent, "Fragment prepared child heading");
      assert.equal(fragmentPanel?.querySelector("pre code")?.textContent, "const fragmentPreparedChild = 19;");
      assert.ok(fragmentPanel?.querySelector("[data-native-table-wrapper]"), "fragment flow children retain the native table override");
      assert.deepEqual(
        Array.from(fragmentPanel?.querySelectorAll("tbody tr") ?? [], (row) =>
          Array.from(row.querySelectorAll("td"), (cell) => cell.textContent),
        ),
        [["owner", "fragment"]],
        "fragment flow children preserve the prepared native table owner",
      );
      const nestedParagraph = panel?.querySelector("p");
      assert.equal(nestedParagraph?.textContent, "Prepared paragraph before shared lexical scope after.", "native child paragraphs retain their native wrapper");
      assert.equal(
        nestedParagraph?.querySelector('[data-card-value="shared lexical scope"]')?.tagName,
        "SPAN",
        "inline JSX inside a prepared native child remains in its paragraph",
      );
      assert.equal(paragraph?.querySelector('[data-card-value="shared lexical scope"]')?.tagName, "SPAN", "inline JSX remains inside the native paragraph");
      assert.equal(paragraph?.querySelector('aside[data-card-value="flow"]'), null, "flow DOM stays outside surrounding native paragraph wrappers");
      assert.equal(
        paragraph?.querySelector("strong")?.textContent,
        "before shared lexical scope after",
        "paragraph formatting spans the projected expression",
      );
      assert.ok(paragraph?.textContent?.includes("{literal}"), "escaped braces remain literal");
      assert.equal(paragraph?.querySelector("code")?.textContent, "{inlineCode}", "inline code remains opaque");
      assert.equal(
        Array.from(paragraph?.querySelectorAll("strong") ?? []).find((node) => node.textContent?.includes("punctuation"))?.textContent,
        "punctuation *stays* literal",
        "Markdown punctuation inside a trusted expression does not flatten its surrounding formatting",
      );
      assert.equal(container.querySelector("blockquote strong")?.textContent, "Quote & before shared lexical scope after.");
      assert.equal(container.querySelector("blockquote [data-trusted-card]")?.getAttribute("data-card-title"), "quote *punctuation* entity");
      assert.equal(container.querySelector("li em")?.textContent, "List & before shared lexical scope after.");
      assert.equal(container.querySelector("li [data-trusted-card]")?.getAttribute("data-card-title"), "list *punctuation* entity");
      const nativeDocumentTable = Array.from(container.querySelectorAll("table")).find(
        (table) => table.closest("[data-trusted-card]") === null,
      );
      assert.deepEqual(
        Array.from(nativeDocumentTable?.querySelectorAll("tbody tr:first-child td") ?? [], (cell) => cell.textContent),
        ["Table", "before shared lexical scope after"],
        "native table cells retain their authored boundaries around the trusted leaf",
      );
      assert.equal(container.querySelector('[data-card-value="shared lexical scope"]')?.getAttribute("data-card-value"), "shared lexical scope");
      assert.ok(container.textContent?.includes("const nativeCode = 7;"), "native code fence remains in the Markdown tree");
      assert.equal(container.querySelectorAll("[data-document-layout]").length, 1, "authored layout wraps the native document exactly once");
    }

    await act(async () => { firstRoot.unmount(); });
    firstUnmounted = true;
    assert.equal(
      secondContainer.querySelector('[data-card-value="shared lexical scope"]')?.textContent,
      "shared lexical scope",
      "disposing one lease leaves its sibling consumer alive",
    );
  } finally {
    if (!firstUnmounted) await act(async () => { firstRoot.unmount(); });
    await act(async () => { secondRoot.unmount(); });
    firstContainer.remove();
    secondContainer.remove();
    engine.dispose();
  }
}

async function testCompleteTextReplacementFailureAndSameLeaseRollback(): Promise<void> {
  let boomRenderAttempts = 0;
  const Card: React.FC<{ value?: string }> = ({ value }) => {
    const failRetainedRender = React.useContext(RetainedFrameRenderFailureContext);
    if (value === "boom") {
      boomRenderAttempts += 1;
      throw new Error("candidate render failed");
    }
    if (value === "last valid module" && failRetainedRender) {
      throw new Error("retained frame host render failed");
    }
    return <span data-lease-card-value={value}>{value}</span>;
  };
  const generatedCodeLines = Array.from(
    { length: 220 },
    (_, index) => `const retainedNativeLine${index} = ${index};`,
  );
  const escapedSourceLine = 'const retainedLiteralMarkup = "<script>escaped source</script>";';
  const codeLines = [...generatedCodeLines, escapedSourceLine];
  const source = [
    'import { Card } from "host:widgets";',
    'export const goodValue = "last valid module";',
    "",
    "<Card value={goodValue} />",
    "",
    "```js",
    ...codeLines,
    "```",
  ].join("\n");
  const candidateSource = [
    'import { Card } from "host:widgets";',
    'export const candidateValue = "failed replacement";',
    "",
    '<Card value="boom" />',
  ].join("\n");
  const candidateCompileGate = deferred<void>();
  let candidateCompileStarted = false;
  const engine = makeEngine(Card, async (candidate) => {
    if (candidate === candidateSource) {
      candidateCompileStarted = true;
      await candidateCompileGate.promise;
    }
    return compileTrustedMdxDocument(candidate);
  });
  const container = document.createElement("div");
  const leaseContainer = document.createElement("div");
  document.body.append(container, leaseContainer);
  const root = createRoot(container);
  const leaseRoot = createRoot(leaseContainer);
  const handle = createRef<StreamingMarkdownHandle>();
  const lease = engine.createDocument();
  let goodBlocks: readonly Block[] = [];
  let candidateBlocks: readonly Block[] = [];
  const tokenizeRangeRequests: string[] = [];
  let renderedCodeTokenizedUntil: number | null = null;
  const captureCodeMetadata: React.FC<CodeFenceRendererProps> = ({ code, meta, renderCode }) => {
    if (code.includes(codeLines[0])) {
      renderedCodeTokenizedUntil = typeof meta?.lazyTokenizedUntil === "number"
        ? meta.lazyTokenizedUntil
        : null;
    }
    return <>{renderCode}</>;
  };
  const codeRenderers = { js: captureCodeMetadata };
  const workerWithTrace = () => workerFactory((blockId) => tokenizeRangeRequests.push(blockId));
  const previousVirtualizedCodeSetting = process.env.STREAM_MDX_DISABLE_VIRTUALIZED_CODE;
  process.env.STREAM_MDX_DISABLE_VIRTUALIZED_CODE = "true";

  try {
    await act(async () => {
      root.render(
        <RetainedFrameRenderFailureContext.Provider value={false}>
          <StreamingMarkdown
            ref={handle}
            engine="worker"
            worker={workerWithTrace}
            contentPolicy="trusted-mdx"
            engines={{ mdx: engine }}
            features={features}
            codeRenderers={codeRenderers}
            text={source}
            caret={false}
          />
        </RetainedFrameRenderFailureContext.Provider>,
      );
    });
    await waitFor(
      () => container.querySelector('[data-lease-card-value="last valid module"]') !== null,
      "the initial complete native generation commits the good module",
    );
    goodBlocks = handle.current?.getState().blocks ?? [];
    assert.ok(goodBlocks.length > 0);
    const codeBlock = goodBlocks.find((block) => block.type === "code");
    assert.ok(codeBlock, "the complete source produces a real native code block");
    assert.equal(
      codeBlock.payload.meta?.lazyTokenization,
      true,
      "the real worker prepares this long code block for lazy tokenization",
    );
    await waitFor(() => {
      const currentState = handle.current?.getState();
      const tokenizedUntil = currentState?.store.getNode(codeBlock.id)?.block?.payload.meta?.lazyTokenizedUntil;
      return tokenizeRangeRequests.includes(codeBlock.id) &&
        typeof tokenizedUntil === "number" &&
        tokenizedUntil >= codeLines.length &&
        renderedCodeTokenizedUntil === tokenizedUntil;
    }, "the real mounted code view sends a range to the inline worker, receives store enrichment, and renders it");
    const tokenizeRequestsBeforeReplacement = tokenizeRangeRequests.filter((id) => id === codeBlock.id).length;
    assert.ok(tokenizeRequestsBeforeReplacement > 0, "the enrichment came from a real TOKENIZE_RANGE worker request");
    renderedCodeTokenizedUntil = null;

    await act(async () => {
      root.render(
        <RetainedFrameRenderFailureContext.Provider value={false}>
          <StreamingMarkdown
            ref={handle}
            engine="worker"
            worker={workerWithTrace}
            contentPolicy="trusted-mdx"
            engines={{ mdx: engine }}
            features={features}
            codeRenderers={codeRenderers}
            text={candidateSource}
            caret={false}
          />
        </RetainedFrameRenderFailureContext.Provider>,
      );
    });
    await waitFor(
      () => candidateCompileStarted && container.querySelector("[data-trusted-mdx-retained-frame]") !== null,
      "a pending complete replacement keeps the exact previously committed native frame visible",
    );
    const retainedFrame = container.querySelector("[data-trusted-mdx-retained-frame]");
    assert.ok(retainedFrame);
    const retainedGeneration = retainedFrame.getAttribute("data-trusted-mdx-retained-source-generation");
    const retainedDocumentRevision = retainedFrame.getAttribute("data-trusted-mdx-retained-document-revision");
    assert.ok(retainedDocumentRevision);
    const requestedGeneration = container.querySelector("[data-trusted-mdx-current-candidate]")
      ?.getAttribute("data-trusted-mdx-current-candidate");
    assert.ok(retainedGeneration);
    assert.ok(requestedGeneration);
    assert.notEqual(retainedGeneration, requestedGeneration, "the retained UI names its real older source generation");
    assert.ok(retainedFrame.textContent?.includes('goodValue = "last valid module"'), "the retained frame identifies its original source");
    assert.ok(
      container.querySelector("[data-trusted-mdx-current-candidate]")?.textContent?.includes(candidateSource),
      "the pending current source remains accessible beside the retained frame",
    );
    assert.ok(
      retainedFrame.querySelector("pre code")?.textContent?.includes(codeLines[0]),
      "the retained frame keeps its real prepared native code visuals",
    );
    assert.equal(
      renderedCodeTokenizedUntil,
      0,
      "the retained native snapshot keeps commit-time code metadata instead of later live worker enrichment",
    );
    assert.equal(
      container.querySelectorAll('[data-lease-card-value="last valid module"]').length,
      1,
      "the old evaluated projection is only present inside its labelled captured-source frame",
    );
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 120));
    });
    assert.equal(
      tokenizeRangeRequests.filter((id) => id === codeBlock.id).length,
      tokenizeRequestsBeforeReplacement,
      "the retained old node never dispatches its stale code job to the new live worker",
    );

    candidateCompileGate.resolve();
    await waitFor(
      () => boomRenderAttempts > 0 &&
        container.querySelector("[data-trusted-mdx-current-diagnostic]")?.textContent?.includes("candidate render failed") === true,
      "the complete replacement candidate fails render and becomes inert with a diagnostic",
    );
    assert.ok(boomRenderAttempts > 0, "the complete candidate reached and threw from the host component");
    assert.equal(
      tokenizeRangeRequests.filter((id) => id === codeBlock.id).length,
      tokenizeRequestsBeforeReplacement,
      "the actual host render failure does not dispatch a retained-frame code job",
    );
    candidateBlocks = handle.current?.getState().blocks ?? [];
    assert.ok(candidateBlocks.length > 0);
    assert.ok(container.textContent?.includes('value="boom"'), "the failed complete candidate remains visible as authored source");
    assert.equal(container.querySelector('[data-lease-card-value="boom"]'), null, "the failing component never remains rendered");
    assert.equal(
      container.querySelector('[data-lease-card-value="last valid module"]')?.textContent,
      "last valid module",
      "a failed complete replacement keeps the actually committed module with its older native source revision",
    );
    assert.equal(
      container.querySelector("[data-trusted-mdx-retained-frame]")?.getAttribute("data-trusted-mdx-retained-source-generation"),
      retainedGeneration,
      "a render-failed replacement continues showing the same correctly identified committed frame",
    );
    assert.ok(
      container.querySelector("[data-trusted-mdx-current-diagnostic]")?.textContent?.includes("candidate render failed"),
      "the current render diagnostic remains accessible alongside the older committed frame",
    );
    await act(async () => {
      root.render(
        <RetainedFrameRenderFailureContext.Provider value={true}>
          <StreamingMarkdown
            ref={handle}
            engine="worker"
            worker={workerWithTrace}
            contentPolicy="trusted-mdx"
            engines={{ mdx: engine }}
            features={features}
            codeRenderers={codeRenderers}
            text={candidateSource}
            caret={false}
          />
        </RetainedFrameRenderFailureContext.Provider>,
      );
    });
    await waitFor(
      () => container.querySelector("[data-trusted-mdx-retained-frame-error]") !== null,
      "a retained host render error stays visible with its original source identity",
    );
    const retainedFrameError = container.querySelector("[data-trusted-mdx-retained-frame-error]");
    assert.ok(retainedFrameError?.textContent?.includes(`source generation ${retainedGeneration}`));
    assert.ok(retainedFrameError?.textContent?.includes(`document revision ${retainedDocumentRevision}`));
    assert.ok(retainedFrameError?.textContent?.includes(escapedSourceLine));
    assert.equal(retainedFrameError?.querySelector("script"), null, "captured authored source is escaped, not interpreted as HTML");

    const validReplacementSource = [
      'import { Card } from "host:widgets";',
      'export const goodValue = "new valid module";',
      "",
      "<Card value={goodValue} />",
    ].join("\n");
    await act(async () => {
      root.render(
        <RetainedFrameRenderFailureContext.Provider value={false}>
          <StreamingMarkdown
            ref={handle}
            engine="worker"
            worker={workerWithTrace}
            contentPolicy="trusted-mdx"
            engines={{ mdx: engine }}
            features={features}
            codeRenderers={codeRenderers}
            text={validReplacementSource}
            caret={false}
          />
        </RetainedFrameRenderFailureContext.Provider>,
      );
    });
    await waitFor(
      () => container.querySelector('[data-lease-card-value="new valid module"]') !== null
        && container.querySelector("[data-trusted-mdx-retained-frame]") === null,
      "a successful current commit replaces and releases the older captured frame",
    );

    await lease.compileRevision({ source, blocks: goodBlocks });
    const goodOwners = trustedOwners(goodBlocks, lease.getSnapshot());
    assert.ok(goodOwners.some((owner) => owner.source.includes("<Card value={goodValue}")), "the lease projects the actual completed native JSX owner");
    const committedOwnerIds = new Set(goodOwners.map((owner) => owner.ownerId));
    const readyGoodRevision = lease.getSnapshot().projectionRevision;
    assert.notEqual(readyGoodRevision, null);
    await act(async () => {
      leaseRoot.render(<TrustedDocumentProjection lease={lease} owners={goodOwners} />);
    });
    await waitFor(
      () => lease.getSnapshot().renderedRevision === readyGoodRevision
        && leaseContainer.querySelector('[data-lease-card-value="last valid module"]') !== null,
      "the explicit trusted document lease commits the rendered good revision",
    );
    const committedSnapshot = lease.getSnapshot();
    await act(async () => {
      leaseRoot.render(null);
    });

    await act(async () => {
      await lease.compileRevision({ source: candidateSource, blocks: candidateBlocks });
    });
    const candidateOwners = trustedOwners(candidateBlocks, lease.getSnapshot());
    assert.ok(
      candidateOwners.some((owner) => owner.source.includes('value="boom"') && !committedOwnerIds.has(owner.ownerId)),
      "the candidate has an exact new owner rather than reusing a good projection's source identity",
    );
    const failedCandidateRevision = lease.getSnapshot().projectionRevision;
    assert.notEqual(failedCandidateRevision, null);
    assert.notEqual(failedCandidateRevision, committedSnapshot.projectionRevision);
    assert.equal(
      lease.getSnapshot().renderedRevision,
      committedSnapshot.renderedRevision,
      "a compiled candidate is not host-committed before its exact candidate owners render",
    );
    await act(async () => {
      leaseRoot.render(<TrustedDocumentProjection lease={lease} owners={candidateOwners} />);
    });
    await waitFor(
      () => lease.getSnapshot().status === "error"
        && leaseContainer.querySelector("[data-mdx-diagnostic]") !== null,
      "the same trusted lease rejects the actually render-failed candidate",
    );
    const rolledBackSnapshot = lease.getSnapshot();
    assert.equal(rolledBackSnapshot.projectionRevision, committedSnapshot.projectionRevision);
    assert.equal(rolledBackSnapshot.renderedRevision, committedSnapshot.renderedRevision);
    assert.deepEqual(rolledBackSnapshot.projections, committedSnapshot.projections);
    assert.equal(rolledBackSnapshot.error, "candidate render failed");
    assert.ok(leaseContainer.textContent?.includes('value="boom"'), "the rejected new owner is inert authored source");
  } finally {
    await act(async () => { root.unmount(); leaseRoot.unmount(); });
    container.remove();
    leaseContainer.remove();
    lease.dispose();
    candidateCompileGate.resolve();
    engine.dispose();
    if (previousVirtualizedCodeSetting === undefined) {
      delete process.env.STREAM_MDX_DISABLE_VIRTUALIZED_CODE;
    } else {
      process.env.STREAM_MDX_DISABLE_VIRTUALIZED_CODE = previousVirtualizedCodeSetting;
    }
  }
}

async function testRetainedNativeFrameRevocation(): Promise<void> {
  const Card: React.FC<{ value?: string }> = ({ value }) => (
    <span data-retained-revoke-value={value}>{value}</span>
  );
  const source = [
    'import { Card } from "host:widgets";',
    'export const value = "last authorized source";',
    "",
    "<Card value={value} />",
  ].join("\n");
  const resetPendingSource = `${source}\n\n<Card value="reset pending" />`;
  const cachePendingSource = `${source}\n\n<Card value="cache pending" />`;
  const policyPendingSource = `${source}\n\n<Card value="policy pending" />`;
  const resetGate = deferred<void>();
  const cacheGate = deferred<void>();
  const policyGate = deferred<void>();
  const gates = new Map<string, Deferred<void>>([
    [resetPendingSource, resetGate],
    [cachePendingSource, cacheGate],
    [policyPendingSource, policyGate],
  ]);
  const started = new Set<string>();
  const engine = makeEngine(Card, async (candidate) => {
    const gate = gates.get(candidate);
    if (gate) {
      started.add(candidate);
      await gate.promise;
    }
    return compileTrustedMdxDocument(candidate);
  });
  const disposePendingSource = `${source}\n\n<Card value="dispose pending" />`;
  const disposeGate = deferred<void>();
  let replacementEngine: TrustedMdxEngine | null = null;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const handle = createRef<StreamingMarkdownHandle>();
  const render = async (
    text: string,
    contentPolicy: "trusted-mdx" | "markdown" = "trusted-mdx",
    activeEngine = engine,
  ): Promise<void> => {
    await act(async () => {
      root.render(
        <StreamingMarkdown
          ref={handle}
          engine="worker"
          worker={workerFactory}
          contentPolicy={contentPolicy}
          engines={{ mdx: activeEngine }}
          features={features}
          text={text}
          caret={false}
        />,
      );
    });
  };

  try {
    await render(source);
    await waitFor(
      () => container.querySelector('[data-retained-revoke-value="last authorized source"]') !== null,
      "the initial complete trusted source commits before revocation checks",
    );

    await render(resetPendingSource);
    await waitFor(
      () => started.has(resetPendingSource) && container.querySelector("[data-trusted-mdx-retained-frame]") !== null,
      "the committed source is retained while an explicitly reset candidate is pending",
    );
    await act(async () => {
      handle.current?.restart();
    });
    assert.equal(
      container.querySelector("[data-trusted-mdx-retained-frame]"),
      null,
      "an explicit feed reset immediately revokes the previously retained frame",
    );
    resetGate.resolve();

    await render(source);
    await waitFor(
      () => container.querySelector('[data-retained-revoke-value="last authorized source"]') !== null,
      "a current trusted source can commit again after explicit reset",
    );
    await render(cachePendingSource);
    await waitFor(
      () => started.has(cachePendingSource) && container.querySelector("[data-trusted-mdx-retained-frame]") !== null,
      "the last committed source is retained during a cache-revocation candidate",
    );
    await act(async () => {
      engine.clearCache();
    });
    assert.equal(
      container.querySelector("[data-trusted-mdx-retained-frame]"),
      null,
      "clearing trusted engine cache revokes captured content even before the candidate resolves",
    );
    cacheGate.resolve();

    await render(source);
    await waitFor(
      () => container.querySelector('[data-retained-revoke-value="last authorized source"]') !== null,
      "the trusted engine recompiles and confirms a current source after cache invalidation",
    );
    await render(policyPendingSource);
    await waitFor(
      () => started.has(policyPendingSource) && container.querySelector("[data-trusted-mdx-retained-frame]") !== null,
      "the committed source is visible while trusted policy still owns a pending replacement",
    );
    await render(policyPendingSource, "markdown");
    assert.equal(
      container.querySelector("[data-trusted-mdx-retained-frame]"),
      null,
      "switching away from trusted MDX policy drops the prior lease's visible frame",
    );
    policyGate.resolve();

    replacementEngine = makeEngine(Card, async (candidate) => {
      if (candidate === disposePendingSource) await disposeGate.promise;
      return compileTrustedMdxDocument(candidate);
    });
    await render(source, "trusted-mdx", replacementEngine);
    await waitFor(
      () => container.querySelector('[data-retained-revoke-value="last authorized source"]') !== null,
      "a replacement trusted engine commits its own real native frame",
    );
    await render(disposePendingSource, "trusted-mdx", replacementEngine);
    await waitFor(
      () => container.querySelector("[data-trusted-mdx-retained-frame]") !== null,
      "the replacement engine's committed frame appears while its next source is pending",
    );
    await act(async () => {
      replacementEngine?.dispose();
    });
    assert.equal(
      container.querySelector("[data-trusted-mdx-retained-frame]"),
      null,
      "disposing a trusted engine revokes its captured native frame immediately",
    );
  } finally {
    resetGate.resolve();
    cacheGate.resolve();
    policyGate.resolve();
    disposeGate.resolve();
    await act(async () => { root.unmount(); });
    container.remove();
    replacementEngine?.dispose();
    engine.dispose();
  }
}

async function testReplacementInvalidatesStaleEvaluationWithReusedBlockIds(): Promise<void> {
  const trace: string[] = [];
  (globalThis as typeof globalThis & { __trustedNativeBoundaryTrace?: string[] }).__trustedNativeBoundaryTrace = trace;
  const oldCompileGate = deferred<void>();
  let oldCompileStarted = false;
  const engine = makeEngine(
    ({ value }) => <aside data-stale-card="true">{value}</aside>,
    async (source) => {
      if (source.includes('return "old"')) {
        oldCompileStarted = true;
        await oldCompileGate.promise;
      }
      return compileTrustedMdxDocument(source);
    },
  );
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const oldSource = [
    'import { Card } from "host:widgets";',
    'export const value = (() => { globalThis.__trustedNativeBoundaryTrace.push("old"); return "old"; })();',
    "",
    "<Card value={value} />",
  ].join("\n");
  const newSource = [
    'import { Card } from "host:widgets";',
    'export const value = (() => { globalThis.__trustedNativeBoundaryTrace.push("new"); return "new"; })();',
    "",
    "<Card value={value} />",
  ].join("\n");
  const handle = createRef<StreamingMarkdownHandle>();

  try {
    await act(async () => {
      root.render(
        <StreamingMarkdown
          ref={handle}
          engine="worker"
          worker={workerFactory}
          contentPolicy="trusted-mdx"
          engines={{ mdx: engine }}
          features={features}
          text={oldSource}
          caret={false}
        />,
      );
    });
    await waitFor(() => oldCompileStarted, "the real old-generation compile is held before replacement");
    const oldBlockIds = handle.current?.getState().blocks.map((block) => block.id) ?? [];
    assert.ok(oldBlockIds.length > 0, "old real worker generation owns parsed blocks before compiler completion");

    await act(async () => {
      root.render(
        <StreamingMarkdown
          ref={handle}
          engine="worker"
          worker={workerFactory}
          contentPolicy="trusted-mdx"
          engines={{ mdx: engine }}
          features={features}
          text={newSource}
          caret={false}
        />,
      );
    });
    await waitFor(() => container.querySelector("[data-stale-card]")?.textContent === "new", "replacement generation commits its own module");
    assert.notEqual(container.querySelector("[data-stale-card]")?.parentElement?.tagName, "P", "a flow owner remains outside native paragraph content after replacement");
    const newBlockIds = handle.current?.getState().blocks.map((block) => block.id) ?? [];
    assert.deepEqual(newBlockIds, oldBlockIds, "real replacement deliberately reuses worker block IDs");

    oldCompileGate.resolve();
    await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 20)); });
    assert.deepEqual(trace, ["new"], "stale authored module is rejected before evaluation after replacement");
    assert.equal(container.querySelector("[data-stale-card]")?.textContent, "new", "stale completion cannot replace the committed generation");
  } finally {
    oldCompileGate.resolve();
    await act(async () => { root.unmount(); });
    container.remove();
    engine.dispose();
    delete (globalThis as typeof globalThis & { __trustedNativeBoundaryTrace?: string[] }).__trustedNativeBoundaryTrace;
  }
}

try {
  await testActualWholeDocumentProjectionAndIndependentConsumers();
  await testCompleteTextReplacementFailureAndSameLeaseRollback();
  await testRetainedNativeFrameRevocation();
  await testReplacementInvalidatesStaleEvaluationWithReusedBlockIds();
} finally {
  restoreTrustedNativeTestDom();
}

console.log("trusted MDX native boundary consumer tests passed");
