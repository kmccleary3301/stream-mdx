import assert from "node:assert";
import type { Block, DiffBlock } from "@stream-mdx/core";
import { JSDOM } from "jsdom";
import React from "react";
import { createRoot } from "react-dom/client";
import { ComponentRegistry } from "../src/components";
import type { InlineNodeViewProps } from "../src/types";
import { BlockNodeRenderer } from "../src/renderer/node-views";
import { compileMarkdownSnapshotDirect } from "@stream-mdx/worker/direct";
import { createRendererStore } from "../src/renderer/store";

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function waitFor(container: Element, predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `${message}\n${container.innerHTML}`);
    await sleep(10);
  }
}

async function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = window;
  g.document = window.document;
  g.HTMLElement = window.HTMLElement;
  g.HTMLIFrameElement = window.HTMLIFrameElement;
  g.Node = window.Node;
  g.MessageEvent = window.MessageEvent;
  g.requestAnimationFrame = window.requestAnimationFrame.bind(window);
  g.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
  return window;
}


// Test 2: Structured diff renderer rows, line numbers, and token colors
async function testDiffRendererRowsAndTokens(): Promise<void> {
  const diffBlocks: DiffBlock[] = [
    {
      kind: "diff",
      filePath: "src/calc.ts",
      additions: 1,
      deletions: 1,
      lines: [
        {
          kind: "hunk",
          oldNo: null,
          newNo: null,
          raw: "@@ -1,2 +1,2 @@",
        },
        {
          kind: "del",
          oldNo: 1,
          newNo: null,
          raw: "-const x = 1;",
          tokens: [{ content: "const x = 1;", color: "#ff0000" }],
        },
        {
          kind: "add",
          oldNo: null,
          newNo: 1,
          raw: "+const x = 2;",
          tokens: [{ content: "const x = 2;", color: "#00ff00" }],
        },
        {
          kind: "context",
          oldNo: 2,
          newNo: 2,
          raw: " console.log(x);",
        },
      ],
    },
  ];

  const window = await setupDom();
  const block: Block = {
    id: "diff-block",
    type: "code",
    isFinalized: true,
    payload: {
      raw: "```diff\n@@ -1,2 +1,2 @@\n-const x = 1;\n+const x = 2;\n console.log(x);\n```",
      meta: {
        lang: "diff",
        diffBlocks,
      },
    },
  };

  const registry = new ComponentRegistry();
  const store = createRendererStore([block]);
  const container = window.document.getElementById("root");
  assert.ok(container);
  const root = createRoot(container);
  root.render(React.createElement(BlockNodeRenderer, { store, blockId: block.id, registry }));
  await sleep(30);

  const diffContainer = container.querySelector(".stream-mdx-diff-container");
  assert.ok(diffContainer, "diff container should be rendered");

  const rows = container.querySelectorAll(".stream-mdx-diff-row");
  assert.strictEqual(rows.length, 4, "should render 4 diff rows");

  // Check hunk row
  const hunkRow = container.querySelector('[data-diff-kind="hunk"]');
  assert.ok(hunkRow, "hunk row present");
  assert.ok(hunkRow.className.includes("diff-line-hunk"));

  // Check del row
  const delRow = container.querySelector('[data-diff-kind="del"]');
  assert.ok(delRow, "del row present");
  assert.ok(delRow.className.includes("diff-line-del"));
  assert.strictEqual(delRow.querySelector(".stream-mdx-diff-old-no")?.textContent?.trim(), "1");
  assert.strictEqual(delRow.querySelector(".stream-mdx-diff-new-no")?.textContent?.trim(), "");

  // Check token colors in del row
  const coloredToken = delRow.querySelector("span[style*='color']");
  assert.ok(coloredToken, "del row token should preserve base-language token color");

  // Check add row
  const addRow = container.querySelector('[data-diff-kind="add"]');
  assert.ok(addRow, "add row present");
  assert.ok(addRow.className.includes("diff-line-add"));
  assert.strictEqual(addRow.querySelector(".stream-mdx-diff-old-no")?.textContent?.trim(), "");
  assert.strictEqual(addRow.querySelector(".stream-mdx-diff-new-no")?.textContent?.trim(), "1");
  // A diff fence without structured metadata must retain its actual code view.
  const fallbackBlock: Block = {
    id: "diff-without-metadata",
    type: "code",
    isFinalized: true,
    payload: {
      raw: "```diff\n-const x = 1;\n+const x = 2;\n```",
      meta: { lang: "diff" },
    },
  };
  const fallbackStore = createRendererStore([fallbackBlock]);
  root.render(React.createElement(BlockNodeRenderer, { store: fallbackStore, blockId: fallbackBlock.id, registry }));
  await waitFor(container, () => Boolean(container.querySelector("pre code")), "diff fallback code view did not render");
  assert.strictEqual(container.querySelector("pre code")?.textContent?.trim(), "-const x = 1;\n+const x = 2;");
  assert.strictEqual(container.querySelector(".stream-mdx-diff-container"), null, "missing diff metadata must not render structured diff");
  assert.strictEqual(container.querySelector(".stream-mdx-diff-row"), null, "fallback must not render structured diff rows");
  root.unmount();
}


// Test 3: KaTeX math rendering and node presentations
async function testKaTeXMathPresentations(): Promise<void> {
  const window = await setupDom();
  const container = window.document.getElementById("root");
  assert.ok(container);
  const result = await compileMarkdownSnapshotDirect({
    text: "Energy $E = mc^2$.\n\n$$\\int x dx$$",
  });
  const store = createRendererStore(result.blocks);
  const root = createRoot(container);
  const renderMath = (registry: ComponentRegistry) => {
    root.render(
      React.createElement(
        React.Fragment,
        null,
        result.blocks.map((block) => React.createElement(BlockNodeRenderer, { key: block.id, store, blockId: block.id, registry })),
      ),
    );
  };

  try {
    renderMath(new ComponentRegistry());
    await waitFor(
      container,
      () => Boolean(container.querySelector(".math-inline .katex") && container.querySelector(".math-display .katex-display .katex")),
      "compiled inline and display math must render actual KaTeX markup",
    );
    assert.strictEqual(container.querySelector(".math-inline")?.getAttribute("data-tex"), "E = mc^2");
    assert.strictEqual(container.querySelector(".math-display")?.getAttribute("data-tex"), "\\int x dx");
    assert.ok(container.querySelector(".math-inline .katex .katex-mathml"), "inline math must contain KaTeX MathML");
    const presentationRegistry = new ComponentRegistry();
    presentationRegistry.setNodePresentations({
      "inline:math": {
        wrapper: ({ children, metadata }) => React.createElement(
          "span",
          { className: "presented-math", "data-node-type": metadata.type, "data-finalized": String(metadata.isFinalized) },
          children,
        ),
      },
    });
    renderMath(presentationRegistry);
    await waitFor(
      container,
      () => Boolean(container.querySelector(".presented-math .math-inline .katex") && container.querySelector(".presented-math .math-display .katex")),
      "math presentation wrappers must preserve KaTeX rendering for inline and display expressions",
    );
    assert.strictEqual(container.querySelectorAll(".presented-math").length, 2);
    assert.strictEqual(container.querySelector(".presented-math")?.getAttribute("data-node-type"), "inline:math");
    assert.strictEqual(container.querySelector(".presented-math")?.getAttribute("data-finalized"), "true");

    const HeadlessMathView = ({ node, children, metadata }: InlineNodeViewProps) =>
      React.createElement("span", {
        className: "headless-math",
        "data-node-kind": node.kind,
        "data-finalized": String(metadata.isFinalized),
      }, children);
    const headlessRegistry = new ComponentRegistry();
    headlessRegistry.setNodePresentations({
      "inline:math": {
        view: HeadlessMathView,
      },
    });
    renderMath(headlessRegistry);
    await waitFor(
      container,
      () => Boolean(container.querySelector(".headless-math .math-inline .katex") && container.querySelector(".headless-math .math-display .katex")),
      "headless math views must receive the prepared engine output",
    );
    assert.strictEqual(container.querySelectorAll(".headless-math").length, 2);
    assert.ok(container.querySelector('.headless-math[data-node-kind="math-inline"]'));
    assert.ok(container.querySelector('.headless-math[data-node-kind="math-display"]'));
    assert.strictEqual(container.querySelector('.headless-math[data-node-kind="math-inline"]')?.getAttribute("data-finalized"), "true");

    assert.ok(container.querySelector(".math-display .katex .katex-mathml"), "display math must contain KaTeX MathML");

  } finally {
    root.unmount();
  }
}

async function testArtifactFencesRemainInertByDefault(): Promise<void> {
  const window = await setupDom();
  const container = window.document.getElementById("root");
  assert.ok(container);

  const artifactSource = '<script>globalThis.__streamMdxArtifactExecuted = true</script>';
  const htmlArtifactSource = '<iframe srcdoc="<script>globalThis.__streamMdxArtifactExecuted = true</script>"></iframe>';
  const markdown = [
    "```artifact",
    artifactSource,
    "```",
    "",
    "```html-artifact",
    htmlArtifactSource,
    "```",
  ].join("\n");
  const result = await compileMarkdownSnapshotDirect({ text: markdown });

  assert.strictEqual(result.blocks.length, 2);
  assert.deepStrictEqual(result.blocks.map((block) => block.payload.meta?.lang), ["artifact", "html-artifact"]);

  const registry = new ComponentRegistry();
  const store = createRendererStore(result.blocks);
  const root = createRoot(container);
  try {
    root.render(
      React.createElement(
        React.Fragment,
        null,
        result.blocks.map((block) => React.createElement(BlockNodeRenderer, { key: block.id, store, blockId: block.id, registry })),
      ),
    );
    await waitFor(container, () => container.querySelectorAll("pre code").length === 2, "artifact fences did not render as code");

    const codeViews = container.querySelectorAll("pre code");
    assert.strictEqual(codeViews[0].textContent?.trim(), artifactSource);
    assert.strictEqual(codeViews[1].textContent?.trim(), htmlArtifactSource);
    assert.strictEqual(container.querySelector("script, iframe"), null, "artifact fence source must remain inert code");
  } finally {
    root.unmount();
  }
}

await testDiffRendererRowsAndTokens();
await testKaTeXMathPresentations();
await testArtifactFencesRemainInertByDefault();
console.log("Code renderers, diff, custom fence, and math tests passed successfully.");
