import assert from "node:assert";
import React from "react";
import { createBlockSnapshot, extractMixedContentSegments, InlineParser } from "@stream-mdx/core";
import type { Block } from "@stream-mdx/core";
import { compileTrustedMdxDocument } from "@stream-mdx/worker/mdx-compile";
import { createTrustedMdxEngine } from "../src/trusted-mdx";
import type { TrustedMdxRevision } from "../src/trusted-mdx-contract";
import fs from "node:fs/promises";
import { renderToStaticMarkup } from "react-dom/server";
import { compileMarkdownSnapshotDirect } from "../../markdown-v2-worker/src/direct-compile";
import { compileTrustedMdxDocument as compileTrustedMdxDocumentFromSource } from "../../markdown-v2-worker/src/mdx-compile";
import { ComponentRegistry, MarkdownBlocksRenderer } from "../src/server";
import { TrustedMdxProjectionContext } from "../src/trusted-mdx-boundary";
declare global {
  var __trustedMdxEffectTrap: string[] | undefined;
}
/**
 * File-local deferred (Node 20 has no `Promise.withResolvers`) with the same resolve/reject
 * surface, so compiler gates preserve their ordering without a global polyfill.
 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const nestedJsxHostComponents = {
  Preview: ({ children, codeblock }: { children?: React.ReactNode; codeblock?: boolean }) =>
    React.createElement("figure", { "data-preview": codeblock ? "codeblock" : "example" }, children),
  PreviewExample: () =>
    React.createElement("span", { "data-preview-example": "" }, "Showcase"),
  YouTube: ({ videoId, caption }: { videoId: string; caption?: string }) =>
    React.createElement("iframe", {
      title: caption ?? "YouTube",
      src: `https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}`,
    }),
  Image: ({ src, alt, caption }: { src: string; alt?: string; caption?: string }) =>
    React.createElement(
      "figure",
      null,
      React.createElement("img", { src, alt: alt ?? "" }),
      caption ? React.createElement("figcaption", null, caption) : null,
    ),
};

async function renderTrustedWorkerSource(source: string): Promise<string> {
  const workerResult = await compileMarkdownSnapshotDirect({
    text: source,
    init: {
      contentPolicy: "trusted-mdx",
      docPlugins: { tables: true, html: true, mdx: true, math: true, footnotes: true },
    },
  });
  const engine = createTrustedMdxEngine({
    components: nestedJsxHostComponents,
    compile: compileTrustedMdxDocumentFromSource,
  });
  const doc = engine.createDocument();
  try {
    await doc.compileRevision({ source, blocks: workerResult.blocks });
    const snapshot = doc.getSnapshot();
    assert.strictEqual(snapshot.status, "ready", snapshot.error ?? "trusted worker source should project");
    assert.deepStrictEqual(
      Object.entries(snapshot.projections).filter(([, projection]) => projection.kind === "unmapped"),
      [],
      "worker-owned MDX source spans should not publish unmapped projections",
    );
    return renderToStaticMarkup(
      <TrustedMdxProjectionContext.Provider value={snapshot}>
        <MarkdownBlocksRenderer
          blocks={workerResult.blocks}
          componentRegistry={new ComponentRegistry()}
        />
      </TrustedMdxProjectionContext.Provider>,
    );
  } finally {
    doc.dispose();
    engine.dispose();
  }
}

async function testWorkerNestedJsxUsesExactAuthoredOwners(): Promise<void> {
  const source = await fs.readFile(
    new URL("../../../tests/regression/fixtures/mdx-components.mdx", import.meta.url),
    "utf8",
  );
  const markup = await renderTrustedWorkerSource(source);
  assert.strictEqual((markup.match(/<pre\b/g) ?? []).length, 2, "only the two authored fenced-code blocks render");
  assert.strictEqual((markup.match(/data-preview-example=""/g) ?? []).length, 1);
  assert.ok(markup.includes("Showcase"), "nested PreviewExample JSX must render through its host binding");
  assert.ok(markup.includes("<strong>Bold</strong>"), "native Markdown children remain rendered by the worker tree");

  const repeated = "<Preview>\n  <PreviewExample />\n  <PreviewExample />\n</Preview>\n";
  const repeatedMarkup = await renderTrustedWorkerSource(repeated);
  assert.strictEqual((repeatedMarkup.match(/data-preview-example=""/g) ?? []).length, 2);
}
async function testRealCompilerSharedLexicalStateAndLayout(): Promise<void> {
  const source = [
    'import { Card } from "host:widgets";',
    "export const sharedCount = 42;",
    'export const dynamicWidgets = import("host:widgets");',
    "export default function CustomLayout({ children }) {",
    '  return <div className="custom-layout">{children}</div>;',
    "}",
    "",
    "# Native Title",
    "",
    "Before <Card count={sharedCount} dynamicWidgets={dynamicWidgets} /> after",
  ].join("\n");

  const CardComponent: React.FC<{
    count?: number;
    dynamicWidgets?: Promise<unknown>;
  }> = ({ count }) => {
    return React.createElement("div", { "data-testid": "card", "data-count": count });
  };

  const engine = createTrustedMdxEngine({
    imports: {
      "host:widgets": {
        Card: CardComponent,
      },
    },
  });

  const doc = engine.createDocument();

  // Create blocks with exact UTF-16 ranges matching source
  const importEnd = source.indexOf("export const sharedCount");
  const exportEnd = source.indexOf("export default function");
  const layoutEnd = source.indexOf("# Native Title");
  const headingEnd = source.indexOf("Before");
  const cardStart = source.indexOf("<Card", headingEnd);
  const cardEnd = source.indexOf("/>", cardStart) + 2;
  const inlineParser = new InlineParser();
  const paragraphRaw = source.slice(headingEnd);
  const mixedSegments = extractMixedContentSegments(
    paragraphRaw,
    headingEnd,
    (content) => inlineParser.parse(content),
  );
  const paragraphBlock: Block = {
    id: "block-mdx-card",
    type: "paragraph",
    isFinalized: true,
    payload: {
      raw: paragraphRaw,
      range: { from: headingEnd, to: source.length },
      meta: { mixedSegments },
    },
  };
  const paragraphSnapshot = createBlockSnapshot(paragraphBlock);
  const cardSegment = paragraphSnapshot.children?.find((child) => child.type === "paragraph-mdx");
  assert.ok(cardSegment, "core paragraph snapshots should expose the MDX segment owner");
  assert.deepStrictEqual(
    cardSegment.range,
    { from: cardStart, to: cardEnd },
    "the MDX segment owner should preserve exact authored source bounds",
  );

  const blocks: Block[] = [
    {
      id: "block-esm-import",
      type: "mdx",
      isFinalized: true,
      payload: {
        raw: source.slice(0, importEnd),
        range: { from: 0, to: importEnd },
      },
    },
    {
      id: "block-esm-export",
      type: "mdx",
      isFinalized: true,
      payload: {
        raw: source.slice(importEnd, exportEnd),
        range: { from: importEnd, to: exportEnd },
      },
    },
    {
      id: "block-esm-layout",
      type: "mdx",
      isFinalized: true,
      payload: {
        raw: source.slice(exportEnd, layoutEnd),
        range: { from: exportEnd, to: layoutEnd },
      },
    },
    {
      id: "block-native-heading",
      type: "heading",
      isFinalized: true,
      payload: {
        raw: source.slice(layoutEnd, headingEnd),
        range: { from: layoutEnd, to: headingEnd },
      },
    },
    paragraphBlock,
  ];

  const revision: TrustedMdxRevision = { source, blocks };
  await doc.compileRevision(revision);

  const snapshot = doc.getSnapshot();
  assert.strictEqual(
    snapshot.status,
    "ready",
    `snapshot should reach ready status; error: ${snapshot.error ?? "none"}`,
  );
  assert.strictEqual(snapshot.projectionRevision, 1, "projectionRevision should be 1");
  assert.strictEqual(snapshot.renderedRevision, null, "renderedRevision should remain null before host commit");

  // Check layout
  assert.ok(snapshot.layout !== null, "document should have extracted CustomLayout");

  // Check projections
  assert.strictEqual(
    snapshot.projections["block-esm-import"]?.kind,
    "module",
    "import block should project as module",
  );
  assert.strictEqual(
    snapshot.projections["block-esm-export"]?.kind,
    "module",
    "export block should project as module",
  );
  assert.strictEqual(
    snapshot.projections["block-esm-layout"]?.kind,
    "module",
    "layout definition block should project as module",
  );
  assert.strictEqual(
    snapshot.projections["block-native-heading"],
    undefined,
    "native markdown heading outside MDX must remain native",
  );

  const cardProj = snapshot.projections[cardSegment.id];
  assert.ok(cardProj && cardProj.kind === "render", "paragraph MDX segment should project as render");
  assert.strictEqual(cardProj.regions.length, 1, "paragraph MDX segment should have 1 render region");
  assert.strictEqual(
    snapshot.projections["block-mdx-card"],
    undefined,
    "the native paragraph owner itself must not be projected",
  );

  // Render the region element and verify shared bindings and dynamic import semantics.
  const RegionComponent = cardProj.regions[0];
  const renderedElement = RegionComponent({});
  if (!React.isValidElement(renderedElement)) {
    throw new Error("The MDX region must return a valid React element.");
  }
  const renderedProps = renderedElement.props;
  if (
    typeof renderedProps !== "object" ||
    renderedProps === null ||
    !("count" in renderedProps) ||
    !("dynamicWidgets" in renderedProps)
  ) {
    throw new Error("The rendered host component is missing expected props.");
  }
  assert.strictEqual(renderedProps.count, 42, "shared lexical state must reach the host component");
  const dynamicWidgets = renderedProps.dynamicWidgets;
  if (!(dynamicWidgets instanceof Promise)) {
    throw new Error("Authored dynamic import must remain a Promise.");
  }
  const importedNamespace: unknown = await dynamicWidgets;
  if (
    typeof importedNamespace !== "object" ||
    importedNamespace === null ||
    !("Card" in importedNamespace)
  ) {
    throw new Error("Dynamic import must resolve the configured host namespace.");
  }
  assert.strictEqual(importedNamespace.Card, CardComponent, "dynamic imports use explicit host bindings");

  engine.dispose();
}

async function testStaleBeforeEvalEffectTrap(): Promise<void> {
  globalThis.__trustedMdxEffectTrap = [];

  const compilerGate = deferred<void>();
  const compilerStarted = deferred<void>();
  const engine = createTrustedMdxEngine({
    compile: async (source: string) => {
      compilerStarted.resolve();
      await compilerGate.promise;
      return compileTrustedMdxDocument(source);
    },
  });
  const doc = engine.createDocument();
  const source = [
    "export const effect = (() => {",
    '  globalThis.__trustedMdxEffectTrap.push("evaluated");',
    "  return 1;",
    "})();",
  ].join("\n");

  const compilePromise = doc.compileRevision({ source, blocks: [] });
  await compilerStarted.promise;
  doc.clear();
  compilerGate.resolve();
  await compilePromise;

  assert.deepStrictEqual(globalThis.__trustedMdxEffectTrap, [], "stale authored code must not execute");
  assert.strictEqual(doc.getSnapshot().status, "idle");
  assert.strictEqual(doc.getSnapshot().requestedRevision, 1);
  assert.strictEqual(doc.getSnapshot().projectionRevision, null);
  delete globalThis.__trustedMdxEffectTrap;

  engine.dispose();
}

async function testOneLeaseClearedWhileAnotherWaits(): Promise<void> {
  const compilerGate = deferred<void>();
  const compilerStarted = deferred<void>();
  let compilerCalls = 0;
  const engine = createTrustedMdxEngine({
    compile: async (source: string) => {
      compilerCalls += 1;
      compilerStarted.resolve();
      await compilerGate.promise;
      return compileTrustedMdxDocument(source);
    },
  });
  const docA = engine.createDocument();
  const docB = engine.createDocument();

  const source = "export const shared = 100;";
  const revision: TrustedMdxRevision = { source, blocks: [] };
  const promiseA = docA.compileRevision(revision);
  const promiseB = docB.compileRevision(revision);
  await compilerStarted.promise;

  docA.clear();
  compilerGate.resolve();
  await Promise.all([promiseA, promiseB]);

  const snapA = docA.getSnapshot();
  const snapB = docB.getSnapshot();
  assert.strictEqual(compilerCalls, 1, "both leases should share one pure compilation");
  assert.strictEqual(snapA.status, "idle", "docA should remain cleared");
  assert.strictEqual(snapA.projectionRevision, null, "docA should have no projection");
  assert.strictEqual(snapB.status, "ready", "docB should complete independently");
  assert.strictEqual(snapB.projectionRevision, 1, "docB should reach projection revision 1");

  engine.dispose();
}

async function testStableGetSnapshot(): Promise<void> {
  const engine = createTrustedMdxEngine();
  const doc = engine.createDocument();

  const snap1 = doc.getSnapshot();
  const snap2 = doc.getSnapshot();
  assert.strictEqual(snap1, snap2, "repeated getSnapshot calls must return exact same reference");

  const source = "# Title\n";
  const revision: TrustedMdxRevision = { source, blocks: [] };
  const compilePromise = doc.compileRevision(revision);

  const snapCompiling1 = doc.getSnapshot();
  const snapCompiling2 = doc.getSnapshot();
  assert.strictEqual(
    snapCompiling1,
    snapCompiling2,
    "compiling snapshots must be reference-stable between transitions",
  );

  await compilePromise;

  const snapReady1 = doc.getSnapshot();
  const snapReady2 = doc.getSnapshot();
  assert.strictEqual(
    snapReady1,
    snapReady2,
    "ready snapshots must be reference-stable between transitions",
  );
  assert.notStrictEqual(snap1, snapReady1, "new snapshot reference emitted on real transition");

  engine.dispose();
}

async function testLastValidRevisionOnCompileOrRenderFailure(): Promise<void> {
  const engine = createTrustedMdxEngine({ components: { Ok: "span", Candidate: "span", Widget: "span" } });
  const doc = engine.createDocument();

  const source1 = "export default function Layout({ children }) { return children; }\nexport const ok = 1;\n\n<Ok val={ok} />";
  const block1: Block = {
    id: "block-1",
    type: "mdx",
    isFinalized: true,
    payload: {
      raw: "<Ok val={ok} />",
      range: { from: source1.indexOf("<Ok"), to: source1.length },
    },
  };
  await doc.compileRevision({ source: source1, blocks: [block1] });
  const committedSnapshot = doc.getSnapshot();
  assert.strictEqual(committedSnapshot.status, "ready", committedSnapshot.error ?? "valid initial revision must compile");
  assert.strictEqual(committedSnapshot.projectionRevision, 1);
  assert.ok(committedSnapshot.layout !== null);
  const committedLayout = committedSnapshot.layout;
  doc.confirmRenderedRevision(1);
  assert.strictEqual(doc.getSnapshot().renderedRevision, 1);

  const source2 = "export default function CandidateLayout({ children }) { return children; }\nexport const candidate = 2;\n\n<Candidate value={candidate} />";
  const candidateFrom = source2.indexOf("<Candidate");
  const candidateBlock: Block = {
    id: "block-candidate",
    type: "mdx",
    isFinalized: true,
    payload: {
      raw: source2.slice(candidateFrom),
      range: { from: candidateFrom, to: source2.length },
    },
  };
  await doc.compileRevision({ source: source2, blocks: [candidateBlock] });
  assert.strictEqual(doc.getSnapshot().projectionRevision, 2);
  assert.strictEqual(doc.getSnapshot().renderedRevision, 1);
  assert.strictEqual(doc.getSnapshot().projections["block-candidate"]?.kind, "render");
  assert.notStrictEqual(doc.getSnapshot().layout, committedLayout);

  const invalidSource = "export const bad = ;;;";
  await doc.compileRevision({ source: invalidSource, blocks: [] });
  let snapshot = doc.getSnapshot();
  assert.strictEqual(snapshot.status, "error");
  assert.ok(snapshot.error !== null);
  assert.strictEqual(
    snapshot.projectionRevision,
    1,
    "failed compilation must restore the last actually committed projection",
  );
  assert.strictEqual(snapshot.renderedRevision, 1);
  assert.strictEqual(snapshot.projections["block-1"]?.kind, "render");
  assert.strictEqual(snapshot.projections["block-candidate"], undefined);
  assert.strictEqual(snapshot.layout, committedLayout);

  const source4 = "export default function V4Layout({ children }) { return children; }\nexport const v4 = 4;\n\n<Widget v4={v4} />";
  const source4From = source4.indexOf("<Widget");
  const block4: Block = {
    id: "block-4",
    type: "mdx",
    isFinalized: true,
    payload: {
      raw: source4.slice(source4From),
      range: { from: source4From, to: source4.length },
    },
  };
  await doc.compileRevision({ source: source4, blocks: [block4] });
  snapshot = doc.getSnapshot();
  assert.strictEqual(snapshot.status, "ready");
  assert.strictEqual(snapshot.projectionRevision, 4);
  assert.strictEqual(snapshot.renderedRevision, 1);
  assert.notStrictEqual(snapshot.layout, committedLayout);

  doc.reportRenderError(4, new Error("Host render exploded on revision 4"));
  snapshot = doc.getSnapshot();
  assert.strictEqual(snapshot.status, "error");
  assert.strictEqual(
    snapshot.projectionRevision,
    1,
    "render failure must restore the last actually committed projection",
  );
  assert.strictEqual(snapshot.renderedRevision, 1);
  assert.ok(snapshot.projections["block-1"] !== undefined);
  assert.strictEqual(snapshot.projections["block-4"], undefined);
  assert.strictEqual(snapshot.layout, committedLayout);

  engine.dispose();
}

async function testClearDoesNotDeleteReplacementInflight(): Promise<void> {
  const compilerGates = [deferred<void>(), deferred<void>()];
  const firstCompilerStarted = deferred<void>();
  const replacementCompilerStarted = deferred<void>();
  let compilerCalls = 0;
  const engine = createTrustedMdxEngine({
    compile: async (source: string) => {
      const call = compilerCalls++;
      if (call === 0) firstCompilerStarted.resolve();
      if (call === 1) replacementCompilerStarted.resolve();
      const gate = compilerGates[call];
      if (!gate) throw new Error("Unexpected extra compilation.");
      await gate.promise;
      return compileTrustedMdxDocument(source);
    },
  });

  const source = "export const shared = 7;";
  const revision: TrustedMdxRevision = { source, blocks: [] };
  const oldDocument = engine.createDocument();
  const oldCompile = oldDocument.compileRevision(revision);
  await firstCompilerStarted.promise;

  engine.clearCache();
  const replacementDocument = engine.createDocument();
  const replacementCompile = replacementDocument.compileRevision(revision);
  await replacementCompilerStarted.promise;

  compilerGates[0].resolve();
  await oldCompile;
  const sharedDocument = engine.createDocument();
  const sharedReplacementCompile = sharedDocument.compileRevision(revision);
  await Promise.resolve();

  assert.strictEqual(
    compilerCalls,
    2,
    "the old compilation's finally handler must not remove the replacement promise",
  );

  compilerGates[1].resolve();
  await Promise.all([replacementCompile, sharedReplacementCompile]);
  assert.strictEqual(replacementDocument.getSnapshot().status, "ready");
  assert.strictEqual(sharedDocument.getSnapshot().status, "ready");
  assert.strictEqual(oldDocument.getSnapshot().status, "idle");

  engine.dispose();
}

async function testClearAndConfirmTerminalLifecycle(): Promise<void> {
  const engine = createTrustedMdxEngine();
  const doc = engine.createDocument();
  let notifications = 0;
  const unsubscribe = doc.subscribe(() => {
    notifications += 1;
  });

  const revision: TrustedMdxRevision = {
    source: "export const stable = true;",
    blocks: [],
  };
  await doc.compileRevision(revision);
  assert.strictEqual(doc.getSnapshot().requestedRevision, 1);

  doc.confirmRenderedRevision(1);
  const committedSnapshot = doc.getSnapshot();
  const committedNotifications = notifications;
  doc.confirmRenderedRevision(1);
  assert.strictEqual(doc.getSnapshot(), committedSnapshot, "repeat confirmation must retain snapshot identity");
  assert.strictEqual(notifications, committedNotifications, "repeat confirmation must not notify");

  doc.clear();
  const clearedSnapshot = doc.getSnapshot();
  assert.strictEqual(clearedSnapshot.status, "idle");
  assert.strictEqual(clearedSnapshot.requestedRevision, 1, "clear must not reset requested revision");
  assert.strictEqual(clearedSnapshot.projectionRevision, null);
  assert.strictEqual(clearedSnapshot.renderedRevision, null);
  assert.strictEqual(clearedSnapshot.layout, null);
  assert.deepStrictEqual(Object.keys(clearedSnapshot.projections), []);
  doc.clear();
  assert.strictEqual(doc.getSnapshot(), clearedSnapshot, "repeated idle clear must not publish a snapshot");

  await doc.compileRevision(revision);
  assert.strictEqual(doc.getSnapshot().requestedRevision, 2, "the next revision after clear must keep increasing");
  assert.strictEqual(doc.getSnapshot().renderedRevision, null, "a ready candidate is not host-confirmed");
  doc.dispose();
  const disposedSnapshot = doc.getSnapshot();
  const notificationsAtDispose = notifications;
  assert.strictEqual(disposedSnapshot.status, "disposed");
  assert.strictEqual(disposedSnapshot.requestedRevision, 2);
  assert.strictEqual(disposedSnapshot.projectionRevision, null);
  assert.strictEqual(disposedSnapshot.renderedRevision, null);
  assert.strictEqual(disposedSnapshot.layout, null);
  assert.deepStrictEqual(Object.keys(disposedSnapshot.projections), []);

  doc.subscribe(() => {
    throw new Error("A disposed document must not retain new listeners.");
  });
  doc.clear();
  doc.confirmRenderedRevision(2);
  doc.reportRenderError(2, new Error("ignored after disposal"));
  await doc.compileRevision(revision);
  assert.strictEqual(doc.getSnapshot(), disposedSnapshot, "disposed documents must be terminal");
  assert.strictEqual(notifications, notificationsAtDispose);

  unsubscribe();
  engine.dispose();
}

async function testFactoryClearAndDisposeLeaseViews(): Promise<void> {
  const Widget: React.FC = () => React.createElement("div");
  const engine = createTrustedMdxEngine({ components: { Widget } });
  const docA = engine.createDocument();
  const docB = engine.createDocument();
  const source = "export default function Layout({ children }) { return children; }\n\n<Widget />";
  const blockFrom = source.indexOf("<Widget");
  const revision: TrustedMdxRevision = {
    source,
    blocks: [{
      id: "factory-mdx-block",
      type: "mdx",
      isFinalized: true,
      payload: {
        raw: source.slice(blockFrom),
        range: { from: blockFrom, to: source.length },
      },
    }],
  };

  await Promise.all([docA.compileRevision(revision), docB.compileRevision(revision)]);
  assert.strictEqual(docA.getSnapshot().status, "ready");
  assert.strictEqual(docB.getSnapshot().status, "ready");
  assert.ok(docA.getSnapshot().layout !== null);
  assert.strictEqual(docA.getSnapshot().projections["factory-mdx-block"]?.kind, "render");
  docA.confirmRenderedRevision(1);
  docB.confirmRenderedRevision(1);

  engine.clearCache();
  for (const doc of [docA, docB]) {
    const snapshot = doc.getSnapshot();
    assert.strictEqual(snapshot.status, "idle");
    assert.strictEqual(snapshot.requestedRevision, 1);
    assert.strictEqual(snapshot.projectionRevision, null);
    assert.strictEqual(snapshot.renderedRevision, null);
    assert.strictEqual(snapshot.layout, null);
    assert.deepStrictEqual(Object.keys(snapshot.projections), []);
  }

  await docA.compileRevision(revision);
  assert.strictEqual(docA.getSnapshot().requestedRevision, 2);
  engine.dispose();
  for (const doc of [docA, docB]) {
    const snapshot = doc.getSnapshot();
    assert.strictEqual(snapshot.status, "disposed");
    assert.strictEqual(snapshot.projectionRevision, null);
    assert.strictEqual(snapshot.renderedRevision, null);
    assert.strictEqual(snapshot.layout, null);
    assert.deepStrictEqual(Object.keys(snapshot.projections), []);
  }
  assert.throws(() => engine.createDocument(), /disposed/);
}

async function testSubscriberFailuresAreNotCompilerErrors(): Promise<void> {
  const engine = createTrustedMdxEngine();
  const doc = engine.createDocument();
  const unsubscribe = doc.subscribe(() => {
    if (doc.getSnapshot().status === "ready") {
      throw new Error("subscriber failed");
    }
  });

  await assert.rejects(
    doc.compileRevision({ source: "export const value = 1;", blocks: [] }),
    /subscriber failed/,
  );
  assert.strictEqual(doc.getSnapshot().status, "ready");
  assert.strictEqual(doc.getSnapshot().error, null);

  unsubscribe();
  engine.dispose();
}

async function runAllFixtures(): Promise<void> {
  await testWorkerNestedJsxUsesExactAuthoredOwners();
  await testRealCompilerSharedLexicalStateAndLayout();
  await testStaleBeforeEvalEffectTrap();
  await testOneLeaseClearedWhileAnotherWaits();
  await testClearDoesNotDeleteReplacementInflight();
  await testClearAndConfirmTerminalLifecycle();
  await testFactoryClearAndDisposeLeaseViews();
  await testSubscriberFailuresAreNotCompilerErrors();
  await testStableGetSnapshot();
  await testLastValidRevisionOnCompileOrRenderFailure();
}

void runAllFixtures();
