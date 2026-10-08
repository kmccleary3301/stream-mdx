import assert from "node:assert";
import type { Block, DiffBlock } from "@stream-mdx/core";
import { JSDOM } from "jsdom";
import React from "react";
import { createRoot } from "react-dom/client";
import {
  ArtifactFrame,
  buildArtifactSrcDoc,
  ComponentRegistry,
  DefaultDiffRenderer,
  KaTeXBlockMath,
  KaTeXInlineMath,
  type CodeFenceRendererProps,
} from "../src/components";
import { BlockNodeRenderer } from "../src/renderer/node-views";
import { createRendererStore } from "../src/renderer/store";

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
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

// Test 1: codeRenderers precedence and normalization
async function testCodeRenderersNormalizationAndPrecedence(): Promise<void> {
  const window = await setupDom();
  let capturedProps: CodeFenceRendererProps | null = null;

  const CustomPython = (props: CodeFenceRendererProps) => {
    capturedProps = props;
    return React.createElement("div", { id: "custom-python", "data-finalized": String(props.isFinalized) }, props.code);
  };

  const registry = new ComponentRegistry();
  // Register with mixed case
  registry.setCodeRenderers({
    PyThOn: CustomPython,
  });

  // Block with uppercase language
  const block: Block = {
    id: "block-py",
    type: "code",
    isFinalized: true,
    payload: {
      raw: "```PYTHON\nprint('hello')\n```",
      meta: { lang: "PYTHON" },
    },
  };

  const store = createRendererStore([block]);
  const container = window.document.getElementById("root");
  assert.ok(container, "root container missing");
  const root = createRoot(container);
  root.render(React.createElement(BlockNodeRenderer, { store, blockId: block.id, registry }));
  await sleep(30);

  const customEl = container.querySelector("#custom-python");
  assert.ok(customEl, "custom renderer should be matched case-insensitively");
  assert.strictEqual(capturedProps?.isFinalized, true, "isFinalized flag must be passed to code renderer");
  assert.strictEqual(capturedProps?.code.trim(), "print('hello')", "code must be stripped of fence markers");
  assert.strictEqual(capturedProps?.language, "PYTHON", "original language string preserved");

  root.unmount();

  // Unknown language falls back to code view
  const window2 = await setupDom();
  const unknownBlock: Block = {
    id: "block-unknown",
    type: "code",
    isFinalized: false,
    payload: {
      raw: "```rust\nfn main() {}\n```",
      meta: { lang: "rust" },
    },
  };
  const store2 = createRendererStore([unknownBlock]);
  const container2 = window2.document.getElementById("root");
  assert.ok(container2);
  const root2 = createRoot(container2);
  root2.render(React.createElement(BlockNodeRenderer, { store: store2, blockId: unknownBlock.id, registry }));
  await sleep(30);

  assert.strictEqual(container2.querySelector("#custom-python"), null);
  assert.ok(container2.querySelector("pre"), "unknown language must fall back to standard code view");
  root2.unmount();
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
  // Also test direct DefaultDiffRenderer fallback when diffBlocks is absent
  root.render(
    React.createElement(DefaultDiffRenderer, {
      code: "raw code",
      language: "diff",
      renderCode: React.createElement("pre", { id: "direct-fallback" }, "raw code"),
    }),
  );
  await sleep(20);
  assert.ok(container.querySelector("#direct-fallback"), "plain path when diffBlocks absent");
  root.unmount();
}

// Test 3: ArtifactFrame sandbox, CSP, finalize, and foreign-source size guard
async function testArtifactFrameLifecycleAndSecurity(): Promise<void> {
  const window = await setupDom();
  const container = window.document.getElementById("root");
  assert.ok(container);

  // Phase A: Not finalized -> code view only, no iframe mounted
  const root = createRoot(container);
  root.render(
    React.createElement(ArtifactFrame, {
      code: "<h1>Hello Artifact</h1>",
      language: "html-artifact",
      isFinalized: false,
      renderCode: React.createElement("pre", { id: "streaming-code" }, "<h1>Hello Artifact</h1>"),
    }),
  );
  await sleep(20);

  assert.ok(container.querySelector("#streaming-code"), "while not finalized, must render fallback code view");
  assert.strictEqual(container.querySelector("iframe"), null, "iframe MUST NOT be mounted before finalize");

  // Phase B: Finalized -> iframe mounted with exact sandbox and CSP meta
  root.render(
    React.createElement(ArtifactFrame, {
      code: "<h1>Hello Artifact</h1>",
      language: "html-artifact",
      isFinalized: true,
      csp: {
        scriptSrc: ["https://cdn.example.com"],
        connectSrc: ["https://api.example.com"],
      },
      renderCode: React.createElement("pre", { id: "streaming-code" }, "<h1>Hello Artifact</h1>"),
    }),
  );
  await sleep(30);

  const iframe = container.querySelector("iframe");
  assert.ok(iframe, "iframe must be mounted when isFinalized is true");

  // Verify sandbox attribute is exactly "allow-scripts" (no allow-same-origin)
  const sandbox = iframe.getAttribute("sandbox");
  assert.strictEqual(sandbox, "allow-scripts", "sandbox attribute must be exactly allow-scripts");
  assert.ok(!sandbox.includes("allow-same-origin"), "sandbox MUST NOT contain allow-same-origin");

  // Verify srcDoc contains CSP meta
  const srcDoc = iframe.getAttribute("srcdoc") || "";
  assert.ok(srcDoc.includes('<meta http-equiv="Content-Security-Policy"'), "srcdoc must contain CSP meta tag");
  assert.ok(srcDoc.includes("default-src 'none'"), "CSP must include default-src 'none'");
  assert.ok(srcDoc.includes("connect-src https://api.example.com"), "CSP connect-src must reflect configured allowlist");
  assert.ok(srcDoc.includes("https://cdn.example.com"), "CSP script-src must reflect configured allowlist");

  // Verify default connect-src 'none' when not specified
  const defaultSrcDoc = buildArtifactSrcDoc({ html: "<p>test</p>" });
  assert.ok(defaultSrcDoc.includes("connect-src 'none'"), "default CSP must have connect-src 'none'");

  // A full document whose own <head> starts with a script must still get the CSP first.
  const fullDoc = buildArtifactSrcDoc({ html: "<!doctype html><script>fetch('https://evil.test')</script><html><head></head><body>x</body></html>" });
  assert.ok(
    fullDoc.indexOf("Content-Security-Policy") < fullDoc.indexOf("evil.test"),
    "CSP must precede every byte of artifact markup",
  );

  // Phase C: Foreign-source size message ignored
  const initialIframeHeight = iframe.style.height;
  // Dispatch a message whose event.source is NOT the iframe's contentWindow
  const foreignEvent = new window.MessageEvent("message", {
    data: { type: "stream-mdx:artifact-size", height: 999 },
    source: window, // foreign source!
  });
  window.dispatchEvent(foreignEvent);
  await sleep(20);

  assert.strictEqual(iframe.style.height, initialIframeHeight, "foreign-source size messages must be ignored");

  // Phase D: link messages from the frame route through openLink; non-http(s)/mailto URLs are dropped.
  const opened: string[] = [];
  root.render(
    React.createElement(ArtifactFrame, {
      code: "<a href='https://example.com'>x</a>",
      language: "html-artifact",
      isFinalized: true,
      openLink: (url: string) => {
        opened.push(url);
      },
      renderCode: null,
    }),
  );
  await sleep(30);
  const frameWindow = container.querySelector("iframe")?.contentWindow;
  assert.ok(frameWindow, "iframe window available");
  for (const href of ["javascript:alert(1)", "data:text/html,x", "https://example.com/next"]) {
    window.dispatchEvent(new window.MessageEvent("message", { data: { type: "stream-mdx:artifact-link", href }, source: frameWindow }));
  }
  await sleep(20);
  assert.deepStrictEqual(opened, ["https://example.com/next"], "only http(s)/mailto links leave the sandbox, via openLink");

  root.unmount();
}

// Test 4: KaTeX math rendering and custom mathRenderer override
async function testKaTeXMathAndOverride(): Promise<void> {
  const window = await setupDom();

  // Test KaTeXInlineMath component directly
  const container = window.document.getElementById("root");
  assert.ok(container);
  const root = createRoot(container);

  root.render(React.createElement(KaTeXInlineMath, { tex: "E = mc^2" }));
  await sleep(30);

  // In Node/jsdom, KaTeX renders synchronously or via loadKaTeX
  const inlineEl = container.querySelector(".math-inline");
  assert.ok(inlineEl, "inline math element rendered");
  assert.ok(
    inlineEl.textContent?.includes("E = mc^2") || inlineEl.querySelector(".katex"),
    "math content or KaTeX markup should be present",
  );
  // Test KaTeXBlockMath component directly
  root.render(React.createElement(KaTeXBlockMath, { tex: "\\int x dx" }));
  await sleep(30);
  const blockEl = container.querySelector(".math-display");
  assert.ok(blockEl, "block math element rendered");

  root.unmount();

  // Test mathRenderer override via ComponentRegistry
  const window2 = await setupDom();
  const container2 = window2.document.getElementById("root");
  assert.ok(container2);
  const root2 = createRoot(container2);

  const registry = new ComponentRegistry();
  registry.setMathRenderer({
    inline: ({ tex }) => React.createElement("span", { id: "mathjax-inline" }, `[MathJax: ${tex}]`),
    display: ({ tex }) => React.createElement("div", { id: "mathjax-display" }, `[MathJax Display: ${tex}]`),
  });

  const inlineComp = registry.getInlineComponents()["math-inline"];
  assert.ok(inlineComp, "custom math-inline registered");

  root2.render(React.createElement(inlineComp, { tex: "\\alpha + \\beta" }));
  await sleep(20);

  const customMath = container2.querySelector("#mathjax-inline");
  assert.ok(customMath, "custom mathRenderer must override default KaTeX inline math");
  assert.strictEqual(customMath.textContent, "[MathJax: \\alpha + \\beta]");

  root2.unmount();
}

await testCodeRenderersNormalizationAndPrecedence();
await testDiffRendererRowsAndTokens();
await testArtifactFrameLifecycleAndSecurity();
await testKaTeXMathAndOverride();
console.log("All codeRenderers, diff, artifact, and math tests passed successfully.");
