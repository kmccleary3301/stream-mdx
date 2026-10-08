import assert from "node:assert";
import type { Block, InlineNode } from "@stream-mdx/core";
import { JSDOM } from "jsdom";
import React from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { ComponentRegistry } from "../src/components";
import {
  DEFAULT_CONTROLS_LABELS,
  escapeCsvCell,
  escapeTsvCell,
  getCodeSnippetFilename,
  getExtensionForLanguage,
  resolveCodeControls,
  resolveControlsConfig,
  resolveTableControls,
  tableToCsv,
  tableToMarkdown,
  tableToTsv,
} from "../src/components/controls";
import { MarkdownBlocksRenderer } from "../src/renderer/blocks-renderer";
import { createRendererStore } from "../src/renderer/store";
import type { CodeFenceRendererProps, ControlsComponentProps } from "../src/types";

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message);
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
  g.HTMLButtonElement = window.HTMLButtonElement;
  g.Node = window.Node;
  g.requestAnimationFrame = window.requestAnimationFrame.bind(window);
  g.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
  return window;
}

function createSampleCodeBlock(isFinalized = true): Block {
  return {
    id: "code-1",
    type: "code",
    isFinalized,
    payload: {
      raw: "```typescript\nconst message = 'hello world';\nconsole.log(message);\n```",
      highlightedHtml:
        '<pre class="shiki"><code class="language-typescript"><span class="line">const message = \'hello world\';</span>\n<span class="line">console.log(message);</span></code></pre>',
      meta: {
        lang: "typescript",
        code: "const message = 'hello world';\nconsole.log(message);",
      },
    },
  };
}

function createSampleTableBlock(isFinalized = true): Block {
  const header: InlineNode[][] = [
    [{ kind: "text", text: "Key" }],
    [{ kind: "text", text: "Value" }],
  ];
  const rows: InlineNode[][][] = [
    [
      [{ kind: "text", text: 'a,"b"' }],
      [{ kind: "text", text: "line 1\nline 2" }],
    ],
    [
      [{ kind: "text", text: "simple" }],
      [{ kind: "text", text: "value,with,commas" }],
    ],
  ];

  return {
    id: "table-1",
    type: "table",
    isFinalized,
    payload: {
      raw: '| Key | Value |\n|---|---|\n| a,"b" | line 1<br>line 2 |\n| simple | value,with,commas |',
      meta: {
        header,
        rows,
        align: ["left", "left"],
      },
    },
  };
}

// 1. Controls absent by default: existing code and table markup stays byte-identical
async function testControlsAbsentByDefault(): Promise<void> {
  const window = await setupDom();
  const container = window.document.getElementById("root");
  assert.ok(container, "root element required");

  const blocks = [createSampleCodeBlock(true), createSampleTableBlock(true)];
  const store1 = createRendererStore(blocks);
  const root1 = createRoot(container);

  root1.render(
    React.createElement(MarkdownBlocksRenderer, {
      blocks,
      store: store1,
    }),
  );

  await waitFor(
    () => Boolean(container.querySelector('pre[data-code-block="true"]')),
    "expected code block to render",
  );

  // Assert no control buttons are present anywhere
  const buttons = container.querySelectorAll("button[data-stream-mdx-control]");
  assert.strictEqual(buttons.length, 0, "controls must be absent by default");

  const markupDefault = container.innerHTML;
  root1.unmount();
  container.innerHTML = "";

  // Render with explicit controls={false}
  const store2 = createRendererStore(blocks);
  const root2 = createRoot(container);
  root2.render(
    React.createElement(MarkdownBlocksRenderer, {
      blocks,
      store: store2,
      controls: false,
    }),
  );

  await waitFor(
    () => Boolean(container.querySelector('pre[data-code-block="true"]')),
    "expected code block to render with controls=false",
  );

  const markupExplicitFalse = container.innerHTML;
  assert.strictEqual(
    markupDefault,
    markupExplicitFalse,
    "markup with controls omitted and controls=false must be strictly identical",
  );

  root2.unmount();
  container.innerHTML = "";
}

// 2. Copy writes raw code (not highlighted HTML), works for virtualized code
async function testCopyWritesRawCode(): Promise<void> {
  const window = await setupDom();
  const container = window.document.getElementById("root");
  assert.ok(container, "root element required");

  let clipboardText = "";
  const clipboardMock = {
    writeText: async (text: string) => {
      clipboardText = text;
    },
  };
  try {
    Object.defineProperty(window.navigator, "clipboard", {
      value: clipboardMock,
      configurable: true,
      writable: true,
    });
  } catch {
    // fallback
  }
  Object.defineProperty(globalThis, "navigator", {
    value: { clipboard: clipboardMock },
    configurable: true,
    writable: true,
  });
  const codeBlock = createSampleCodeBlock(true);
  const blocks = [codeBlock];
  const store = createRendererStore(blocks);
  const root = createRoot(container);

  root.render(
    React.createElement(MarkdownBlocksRenderer, {
      blocks,
      store,
      controls: true,
    }),
  );

  await waitFor(
    () => Boolean(container.querySelector('button[data-stream-mdx-control="copy"]')),
    "expected copy button to render when controls=true",
  );

  const copyButton = container.querySelector(
    'button[data-stream-mdx-control="copy"]',
  ) as HTMLButtonElement | null;
  assert.ok(copyButton, "expected copy button");
  assert.strictEqual(copyButton.getAttribute("data-stream-mdx-target"), "code");
  assert.strictEqual(copyButton.getAttribute("type"), "button");

  // Click copy button
  copyButton.click();
  await sleep(20);

  const expectedRawCode = "const message = 'hello world';\nconsole.log(message);";
  assert.strictEqual(
    clipboardText,
    expectedRawCode,
    "copy button must copy raw code text, not highlighted HTML",
  );
  assert.ok(!clipboardText.includes("<span"), "clipboard text must not contain HTML spans");

  root.unmount();
  container.innerHTML = "";
}

// 3. Table CSV escaping for quotes, commas and newlines
function testTableCsvEscaping(): void {
  // Individual cell escaping
  assert.strictEqual(escapeCsvCell('a,"b"'), '"a,""b"""', 'cell a,"b" must escape quotes as double quotes');
  assert.strictEqual(
    escapeCsvCell("line 1\nline 2"),
    '"line 1\nline 2"',
    "multiline cell must be wrapped in quotes",
  );
  assert.strictEqual(escapeCsvCell("plain"), "plain", "plain cell does not need quotes");
  assert.strictEqual(escapeCsvCell("foo,bar"), '"foo,bar"', "cell with comma must be wrapped in quotes");

  // Full table escaping
  const headers = ["Header 1", "Header 2"];
  const rows = [
    ['a,"b"', "line 1\nline 2"],
    ["simple", "comma,here"],
  ];
  const csv = tableToCsv(headers, rows);
  const expectedCsv = 'Header 1,Header 2\n"a,""b""","line 1\nline 2"\nsimple,"comma,here"';
  assert.strictEqual(csv, expectedCsv, "tableToCsv must escape quotes, commas, and newlines per RFC 4180");

  // TSV escaping
  const tsv = tableToTsv(headers, rows);
  assert.ok(!tsv.includes("\nline 2"), "TSV replaces internal newlines");
  assert.ok(tsv.includes("\t"), "TSV uses tab delimiter");

  // Markdown formatting
  const md = tableToMarkdown(headers, rows);
  assert.ok(md.includes("| Header 1 | Header 2 |"), "Markdown headers formatted");
  assert.ok(md.includes("| --- | --- |"), "Markdown separator row present");
}

// 4. Streaming (non-finalized) table has no enabled download
async function testStreamingTableHasNoEnabledDownload(): Promise<void> {
  const window = await setupDom();
  const container = window.document.getElementById("root");
  assert.ok(container, "root element required");

  // Non-finalized (streaming) table
  const streamingTable = createSampleTableBlock(false);
  const blocks = [streamingTable];
  const store = createRendererStore(blocks);
  const root = createRoot(container);

  root.render(
    React.createElement(MarkdownBlocksRenderer, {
      blocks,
      store,
      controls: { table: { copy: true, download: true } },
    }),
  );

  await waitFor(
    () => Boolean(container.querySelector('button[data-stream-mdx-control="download"]')),
    "expected download button to render for streaming table",
  );

  const downloadButton = container.querySelector(
    'button[data-stream-mdx-control="download"]',
  ) as HTMLButtonElement | null;
  assert.ok(downloadButton, "expected download button element");
  assert.strictEqual(
    downloadButton.disabled,
    true,
    "streaming (non-finalized) table download button must be disabled",
  );

  const copyButtons = container.querySelectorAll(
    'button[data-stream-mdx-control="copy"][data-stream-mdx-target="table"]',
  );
  for (const btn of Array.from(copyButtons) as HTMLButtonElement[]) {
    assert.strictEqual(btn.disabled, true, "table copy button must be disabled while streaming");
  }

  root.unmount();
  container.innerHTML = "";

  // Now test with finalized table: controls are enabled
  const finalizedTable = createSampleTableBlock(true);
  const store2 = createRendererStore([finalizedTable]);
  const root2 = createRoot(container);
  root2.render(
    React.createElement(MarkdownBlocksRenderer, {
      blocks: [finalizedTable],
      store: store2,
      controls: { table: { copy: true, download: true } },
    }),
  );

  await waitFor(
    () => {
      const btn = container.querySelector(
        'button[data-stream-mdx-control="download"]',
      ) as HTMLButtonElement | null;
      return Boolean(btn && !btn.disabled);
    },
    "expected finalized table download button to be enabled",
  );

  const finalizedDownload = container.querySelector(
    'button[data-stream-mdx-control="download"]',
  ) as HTMLButtonElement | null;
  assert.ok(finalizedDownload && !finalizedDownload.disabled, "finalized download button must be enabled");

  root2.unmount();
  container.innerHTML = "";
}

// 5. SSR render includes buttons without crashing (no window access during render)
function testSsrRenderIncludesButtonsWithoutCrashing(): void {
  const blocks = [createSampleCodeBlock(true), createSampleTableBlock(true)];
  const registry = new ComponentRegistry();
  registry.setControls(true);

  const html = renderToStaticMarkup(
    React.createElement(MarkdownBlocksRenderer, {
      blocks,
      componentRegistry: registry,
      controls: true,
    }),
  );

  assert.ok(html.includes("<button"), "SSR output must include <button> tags");
  assert.ok(
    html.includes('data-stream-mdx-control="copy"'),
    "SSR output must include copy control button",
  );
  assert.ok(
    html.includes('data-stream-mdx-control="download"'),
    "SSR output must include download control button",
  );
  assert.ok(html.includes('type="button"'), 'SSR buttons must specify type="button"');
  assert.ok(html.includes("aria-label="), "SSR buttons must include aria-label attributes");
}

// 6. Replacement through override slot and i18n labels
async function testControlsReplacementAndLabels(): Promise<void> {
  const window = await setupDom();
  const container = window.document.getElementById("root");
  assert.ok(container, "root element required");

  let customRendered = false;
  const CustomControls: React.FC<ControlsComponentProps> = (props) => {
    customRendered = true;
    return React.createElement(
      "div",
      { id: `custom-controls-${props.type}`, "data-custom": "true" },
      `Custom ${props.type} controls`,
    );
  };

  const blocks = [createSampleCodeBlock(true)];
  const store = createRendererStore(blocks);
  const root = createRoot(container);

  root.render(
    React.createElement(MarkdownBlocksRenderer, {
      blocks,
      store,
      controls: true,
      controlsComponent: CustomControls,
    }),
  );

  await waitFor(
    () => Boolean(container.querySelector('[data-custom="true"]')),
    "expected custom controlsComponent to render",
  );

  assert.strictEqual(customRendered, true, "custom controlsComponent was invoked");
  assert.ok(
    container.querySelector("#custom-controls-code"),
    "custom controls rendered for code block",
  );

  root.unmount();
  container.innerHTML = "";

  // Test custom i18n labels
  const store2 = createRendererStore(blocks);
  const root2 = createRoot(container);
  root2.render(
    React.createElement(MarkdownBlocksRenderer, {
      blocks,
      store: store2,
      controls: {
        code: { copy: true, download: true },
        labels: {
          copy: "Copier le code",
          download: "Télécharger extrait",
        },
      },
    }),
  );

  await waitFor(
    () => Boolean(container.querySelector('button[aria-label="Copier le code"]')),
    "expected custom copy label to be used",
  );

  const copyBtn = container.querySelector('button[aria-label="Copier le code"]');
  assert.ok(copyBtn, "expected button with custom French copy label");
  const downloadBtn = container.querySelector('button[aria-label="Télécharger extrait"]');
  assert.ok(downloadBtn, "expected button with custom French download label");

  root2.unmount();
  container.innerHTML = "";
}

// 7. CodeFenceRendererProps exposes controls flags and copy() helper
async function testCodeFenceRendererControlsProps(): Promise<void> {
  const window = await setupDom();
  const container = window.document.getElementById("root");
  assert.ok(container, "root element required");

  let receivedFenceProps: CodeFenceRendererProps | null = null;
  const CustomFenceRenderer: React.FC<CodeFenceRendererProps> = (props) => {
    receivedFenceProps = props;
    return React.createElement(
      "div",
      { id: "custom-fence" },
      React.createElement(
        "button",
        {
          type: "button",
          id: "custom-fence-copy",
          onClick: () => {
            props.copy?.();
          },
        },
        "Fence Copy",
      ),
      props.renderCode,
    );
  };

  const blocks = [createSampleCodeBlock(true)];
  const store = createRendererStore(blocks);
  const root = createRoot(container);

  root.render(
    React.createElement(MarkdownBlocksRenderer, {
      blocks,
      store,
      controls: { code: { copy: true, download: true } },
      codeRenderers: {
        typescript: CustomFenceRenderer,
      },
    }),
  );

  await waitFor(
    () => Boolean(container.querySelector("#custom-fence")),
    "expected custom fence renderer to mount",
  );

  const props = receivedFenceProps as CodeFenceRendererProps | null;
  assert.ok(props, "expected fence props to be passed");
  assert.strictEqual(props.controls?.copy, true, "props.controls.copy must be true");
  assert.strictEqual(props.controls?.download, true, "props.controls.download must be true");
  assert.strictEqual(typeof props.copy, "function", "props.copy helper must be a function");
  assert.strictEqual(typeof props.download, "function", "props.download helper must be a function");

  root.unmount();
  container.innerHTML = "";
}

// Run all test cases
await testControlsAbsentByDefault();
await testCopyWritesRawCode();
testTableCsvEscaping();
await testStreamingTableHasNoEnabledDownload();
testSsrRenderIncludesButtonsWithoutCrashing();
await testControlsReplacementAndLabels();
await testCodeFenceRendererControlsProps();

console.log("All controls acceptance tests passed successfully.");
