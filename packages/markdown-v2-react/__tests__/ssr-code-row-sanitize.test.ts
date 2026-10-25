import assert from "node:assert/strict";

import { PATCH_ROOT_ID, STREAM_MDX_SCHEMA_VERSION, sanitizeCodeHTML, type Patch, type WorkerOut } from "@stream-mdx/core";
import { createInlineEngineWorker } from "@stream-mdx/worker/engine";
import { JSDOM } from "jsdom";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { MarkdownBlocksRenderer, createRendererStore } from "../src/server";
import type { RendererStore } from "../src/renderer/store";

// Native SSR is exercised without a global DOM. Direct sanitizer coverage below
// compares its DOM-free path with the browser path using a contained window change.
interface WindowCapableGlobal {
  window?: unknown;
}
const globalScope = globalThis as WindowCapableGlobal;
const previousWindow = globalScope.window;
delete globalScope.window;

// Source fixtures resemble JSX and hostile markup but must remain native code text.
const REAL_SHIKI_FENCE_SOURCE = '<StreamingMarkdown worker="/workers/markdown-worker.js" />';
const REAL_SHIKI_FENCE_HTML =
  '<pre class="shiki shiki-themes github-dark github-light" style="--shiki-dark:#e1e4e8;--shiki-light:#24292e;--shiki-dark-bg: transparent;--shiki-light-bg: transparent" tabindex="undefined" data-language="tsx"><code data-language="tsx" data-theme="github-dark github-light" style="display: grid;"><span class="line" data-line="1"><span style="--shiki-dark:#E1E4E8;--shiki-light:#24292E">&#x3C;</span><span style="--shiki-dark:#79B8FF;--shiki-light:#005CC5">StreamingMarkdown</span><span style="--shiki-dark:#B392F0;--shiki-light:#6F42C1"> worker</span><span style="--shiki-dark:#F97583;--shiki-light:#D73A49">=</span><span style="--shiki-dark:#9ECBFF;--shiki-light:#032F62">"/workers/markdown-worker.js"</span><span style="--shiki-dark:#E1E4E8;--shiki-light:#24292E"> /></span></span></code></pre>';

const HOSTILE_CODE_ROW =
  '<span class="line" data-line="2"><script>alert(1)</script><img src="x" onerror="alert(1)"><span onclick="alert(1)">click</span><span style="background:url(javascript:alert(1))">urlstyle</span><a href="javascript:alert(1)">link</a><span style="color:#24292e">safe</span></span>';

const HOSTILE_CODE_SOURCE =
  `const hostile = '<script>alert(1)</script><img src="x" onerror="alert(1)"><span onclick="alert(1)">click</span><a href="javascript:alert(1)">link</a>';`;

function currentCodeOwnerId(store: RendererStore): string | null {
  for (const childId of store.getNode(PATCH_ROOT_ID)?.children ?? []) {
    if (store.getCodeBlock(childId)) return childId;
  }
  return null;
}

async function createHighlightedNativeCodeStore(
  source: string,
): Promise<{ store: RendererStore; blockId: string }> {
  const store = createRendererStore();
  const worker = createInlineEngineWorker();
  let decorationPatch: Extract<Patch, { op: "decorateCode" }> | null = null;
  const readDecorationPatch = (): Extract<Patch, { op: "decorateCode" }> | null => decorationPatch;

  try {
    await new Promise<void>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<WorkerOut>) => {
        const message = event.data;
        if (message.type === "INITIALIZED") {
          store.resetSnapshot(message.snapshot);
          resolve();
        } else if (message.type === "ERROR") {
          reject(new Error(message.error.message));
        }
      };
      worker.postMessage({
        type: "INIT",
        schemaVersion: STREAM_MDX_SCHEMA_VERSION,
        initialContent: "",
        prewarmLangs: [],
        docPlugins: {
          html: false,
          mdx: false,
          tables: false,
          math: false,
          outputMode: "html",
          lazyTokenization: { enabled: true, thresholdLines: 1 },
        },
      });
    });

    const captureDecoration = (patches: readonly Patch[]): void => {
      const decoration = patches.find(
        (patch): patch is Extract<Patch, { op: "decorateCode" }> => patch.op === "decorateCode",
      );
      if (decoration) decorationPatch = decoration;
    };
    await new Promise<void>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<WorkerOut>) => {
        const message = event.data;
        if (message.type === "PATCH") {
          store.applyPatches(message.patches);
          captureDecoration(message.patches);
        } else if (message.type === "FINALIZED") {
          resolve();
        } else if (message.type === "ERROR") {
          reject(new Error(message.error.message));
        }
      };
      worker.postMessage({ type: "APPEND", text: `\`\`\`tsx\n${source}\n\`\`\`` });
      worker.postMessage({ type: "FINALIZE" });
    });

    const blockId = currentCodeOwnerId(store);
    assert.ok(blockId, "inline engine should publish an owned native code block");
    const codeBlock = store.getCodeBlock(blockId);
    assert.ok(codeBlock, "native code owner should expose its source and line records");
    const lines = store.getCodeLines(blockId, 0, codeBlock.source.lineCount);
    assert.equal(lines.map((line) => line.text).join("\n"), source);

    const allLinesDecorated = (): boolean =>
      store.getCodeLines(blockId, 0, codeBlock.source.lineCount).every((line) => line.decoration?.exactness === "exact");
    if (!allLinesDecorated()) {
      await new Promise<void>((resolve, reject) => {
        worker.onmessage = (event: MessageEvent<WorkerOut>) => {
          const message = event.data;
          if (message.type === "PATCH") {
            store.applyPatches(message.patches);
            captureDecoration(message.patches);
            if (allLinesDecorated()) resolve();
          } else if (message.type === "ERROR") {
            reject(new Error(message.error.message));
          }
        };
        worker.postMessage({
          type: "TOKENIZE_RANGE",
          blockId,
          startLine: 0,
          endLine: codeBlock.source.lineCount,
          priority: "visible",
        });
      });
    }
    const actualDecorationPatch = readDecorationPatch();
    assert.ok(actualDecorationPatch, "syntax highlighting should arrive through a real owned-code decoration");
    assert.ok(
      store.getCodeLines(blockId, 0, codeBlock.source.lineCount).some((line) => line.decoration?.tokens.spans.length),
      "native source records should retain the worker's token styles",
    );
    return { store, blockId };
  } finally {
    worker.terminate();
  }
}

/**
 * Canonical DOM serialization so browser/Node outputs are compared by DOM
 * semantics (tags, attributes, text) instead of serializer formatting.
 */
function normalizeHtml(html: string): string {
  const dom = new JSDOM(`<div id="root">${html}</div>`);
  const root = dom.window.document.getElementById("root");
  if (!root) {
    throw new Error("normalizeHtml root missing");
  }
  return root.innerHTML;
}

// DOMPurify `DEFAULT_FORBID_CONTENTS` subtrees are removed with their content
// on both paths; other disallowed tags are unwrapped and keep their content.
// Tags that the HTML parser flattens outside their context (`thead`, `head`)
// cannot be asserted this way; the table case below reaches `thead` as a real
// element instead.
const FORBIDDEN_SUBTREE_TAGS = ["svg", "template", "iframe", "math", "title", "xmp", "video", "noscript"];
const UNWRAPPED_TAGS = ["textarea", "em", "h1"];

const ALIGNMENT_MATRIX = [
  REAL_SHIKI_FENCE_HTML,
  HOSTILE_CODE_ROW,
  '<span class="line"><span style="--shiki-dark:#e1e4e8;--shiki-light:#24292e">alpha</span></span>',
  '<span class="line" data-line="3" style="color:#24292e;font-style:italic">styled</span>',
  '<div class="shiki" data-theme="dark"><pre class="shiki"><code><span class="line">const x = 1;</span></code></pre></div>',
  '<span class="line">text <em>kept</em> <a href="https://example.com">link</a> <h1>block</h1></span>',
  '<span class="line"><!-- note -->kept</span>',
  '<span class="line"><script>alert(1)</script>after</span>',
  '<span aria-hidden="true" id="x" tabindex="0" class="line" data-line="4">attrs</span>',
  '<span class="line" style="background-image:\\75rl(https://attacker.example/pixel)">escaped</span>',
  '<span class="line" style="background-image:u/**/rl(https://attacker.example/pixel)">commented</span>',
  '<span class="line" style="background-image:url(https://attacker.example/pixel)">urled</span>',
  '<span class="line" style="position:fixed;color:#24292e">mixed</span>',
  ...FORBIDDEN_SUBTREE_TAGS.map((tag) => `<span class="line">pre<${tag}>hidden</${tag}>post</span>`),
  ...UNWRAPPED_TAGS.map((tag) => `<span class="line">pre<${tag}>kept</${tag}>post</span>`),
  '<span class="line">A<table><thead><tr><td>cell</td></tr></thead></table>B</span>',
];

const CSS_ESCAPE_BYPASSES = [
  '<span class="line" style="background-image:\\75rl(https://attacker.example/pixel)">escaped</span>',
  '<span class="line" style="background-image:u/**/rl(https://attacker.example/pixel)">commented</span>',
  '<span class="line" style="background-image:url(https://attacker.example/pixel)">urled</span>',
];

function restoreWindow(): void {
  if (typeof previousWindow === "undefined") {
    delete globalScope.window;
  } else {
    globalScope.window = previousWindow;
  }
}

async function main(): Promise<void> {
  assert.strictEqual(typeof globalScope.window, "undefined", "SSR phase requires no global window");

  const nativeSource = `${REAL_SHIKI_FENCE_SOURCE}\n${HOSTILE_CODE_SOURCE}\nconst label = "safe";`;
  const { store, blockId } = await createHighlightedNativeCodeStore(nativeSource);
  const codeBlock = store.getCodeBlock(blockId);
  assert.ok(codeBlock, "SSR fixture should retain its native code owner");
  assert.equal(
    store.getCodeLines(blockId, 0, codeBlock.source.lineCount).map((line) => line.text).join("\n"),
    nativeSource,
    "native source records should preserve the authored lines",
  );

  const ssr = renderToStaticMarkup(
    React.createElement(MarkdownBlocksRenderer, { blocks: [], store }),
  );
  const ssrDom = new JSDOM(ssr);
  const renderedCode = ssrDom.window.document.querySelector("pre code");
  assert.ok(renderedCode, "SSR should render native code rows");
  const renderedSource = renderedCode.textContent ?? "";
  assert.ok(
    renderedSource.includes(nativeSource),
    "SSR code text should preserve JSX-like and hostile attribute-looking source literally",
  );
  assert.equal(
    renderedCode.querySelector("script, img, svg, iframe, [onerror], [onclick], a[href^='javascript:']"),
    null,
    "native code source must not become executable elements or attributes",
  );
  const tokenStyles = Array.from(renderedCode.querySelectorAll("span[style]"))
    .map((span) => span.getAttribute("style") ?? "");
  assert.ok(tokenStyles.some((style) => style.includes("--shiki-dark")), "SSR token styles should retain approved dark-theme colors");
  assert.ok(tokenStyles.some((style) => style.includes("--shiki-light")), "SSR token styles should retain approved light-theme colors");

  // CSS bypass attempts lose their styles in the DOM-free sanitizer.
  for (const input of CSS_ESCAPE_BYPASSES) {
    const out = sanitizeCodeHTML(input);
    assert.ok(!/background-image/i.test(out), `DOM-free path must drop hostile styles: ${out}`);
    assert.ok(!/\\75|url\s*\(|u\/\*\*\/rl/.test(out), `DOM-free path must not keep escaped url(): ${out}`);
    assert.ok(/escaped|commented|urled/.test(out), `DOM-free path must keep row content: ${out}`);
  }

  // Forbidden-content subtrees lose their contents; other disallowed tags stay unwrapped.
  for (const tag of FORBIDDEN_SUBTREE_TAGS) {
    const out = sanitizeCodeHTML(`<span class="line">pre<${tag}>hidden</${tag}>post</span>`);
    assert.ok(!out.includes("hidden"), `forbidden subtree content must be removed (${tag}): ${out}`);
    assert.ok(out.includes("pre") && out.includes("post"), `siblings must survive (${tag}): ${out}`);
  }
  for (const tag of UNWRAPPED_TAGS) {
    const out = sanitizeCodeHTML(`<span class="line">pre<${tag}>kept</${tag}>post</span>`);
    assert.ok(out.includes("kept"), `unwrapped tag content must survive (${tag}): ${out}`);
    assert.ok(!out.includes(`<${tag}`), `tag itself must be removed (${tag}): ${out}`);
  }
  const tableSubtree = sanitizeCodeHTML(
    '<span class="line">A<table><thead><tr><td>cell</td></tr></thead></table>B</span>',
  );
  assert.ok(!tableSubtree.includes("cell"), `table header subtree must be removed: ${tableSubtree}`);

  // Browser path (DOMPurify + template scrub) and Node path must agree by DOM semantics.
  const nodeOutputs = ALIGNMENT_MATRIX.map((input) => normalizeHtml(sanitizeCodeHTML(input)));
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  globalScope.window = dom.window;
  try {
    ALIGNMENT_MATRIX.forEach((input, index) => {
      const browserOutput = normalizeHtml(sanitizeCodeHTML(input));
      assert.strictEqual(
        browserOutput,
        nodeOutputs[index],
        `browser and Node code-row sanitation must agree (matrix input ${index})`,
      );
    });
    const browserHostile = sanitizeCodeHTML(HOSTILE_CODE_ROW);
    assert.ok(!/onerror/i.test(browserHostile), "browser path must drop event handlers");
    assert.ok(!/javascript:/i.test(browserHostile), "browser path must drop javascript: payloads");
    assert.ok(browserHostile.includes("color:#24292e"), "browser path must keep benign theme styles");
    const benignCustomProps = sanitizeCodeHTML(
      '<span class="line"><span style="--shiki-dark:#e1e4e8;--shiki-light:#24292e">alpha</span></span>',
    );
    assert.ok(
      benignCustomProps.includes("--shiki-dark:#e1e4e8"),
      `browser path must keep benign theme variables: ${benignCustomProps}`,
    );
  } finally {
    restoreWindow();
  }

}

try {
  await main();
} finally {
  restoreWindow();
}
console.log("ssr-code-row-sanitize test passed");
