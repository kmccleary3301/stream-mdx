import { STREAM_MDX_SCHEMA_VERSION } from "@stream-mdx/core";

import assert from "node:assert";
import type { Block, Patch, WorkerOut } from "@stream-mdx/core";
import { createRendererStore } from "../../markdown-v2-react/src/renderer/store";
import { MarkdownEngine } from "../src/engine/engine";
import { getSharedHighlightCacheKey } from "../src/engine/highlight";

function collectBlocks(messages: WorkerOut[]): ReadonlyArray<Block> {
  const store = createRendererStore();
  for (const msg of messages) {
    if (msg.type === "INITIALIZED") {
      store.resetSnapshot(msg.snapshot);
    } else if (msg.type === "PATCH") {
      store.applyPatches(msg.patches as Patch[], { captureMetrics: false });
    }
  }
  return store.getBlocks();
}

function getCodeBlock(blocks: ReadonlyArray<Block>): Block {
  const codeBlock = blocks.find((b) => b.type === "code");
  assert.ok(codeBlock, "should produce a code block");
  return codeBlock;
}

async function runWorkerThemesTest(): Promise<void> {
  const codeInput = "```javascript\nconst x = 1;\n```\n";

  // Test 1: INIT with { light: "min-light", dark: "nord" } produces output matching those themes and differing from defaults
  {
    const defaultMessages: WorkerOut[] = [];
    const defaultEngine = new MarkdownEngine({ post: (msg) => defaultMessages.push(msg) });
    await defaultEngine.handle({ type: "INIT", schemaVersion: STREAM_MDX_SCHEMA_VERSION, initialContent: codeInput,
    docPlugins: { codeHighlighting: "final", outputMode: "both", emitHighlightTokens: true, lazyTokenization: { enabled: false } }, });
    await defaultEngine.handle({ type: "FINALIZE" });

    const customMessages: WorkerOut[] = [];
    const customEngine = new MarkdownEngine({ post: (msg) => customMessages.push(msg) });
    await customEngine.handle({ type: "INIT", schemaVersion: STREAM_MDX_SCHEMA_VERSION, initialContent: codeInput,
    themes: { light: "min-light", dark: "nord" },
    docPlugins: { codeHighlighting: "final", outputMode: "both", emitHighlightTokens: true, lazyTokenization: { enabled: false } }, });
    await customEngine.handle({ type: "FINALIZE" });

    const defaultBlocks = collectBlocks(defaultMessages);
    const customBlocks = collectBlocks(customMessages);

    const defaultCode = getCodeBlock(defaultBlocks);
    const customCode = getCodeBlock(customBlocks);

    const defaultHtml = defaultCode.payload.highlightedHtml ?? "";
    const customHtml = customCode.payload.highlightedHtml ?? "";

    assert.ok(defaultHtml.length > 0, "default highlighted HTML must not be empty");
    assert.ok(customHtml.length > 0, "custom highlighted HTML must not be empty");
    assert.notStrictEqual(defaultHtml, customHtml, "custom theme output must differ from default output");

    // Default uses github-light / github-dark
    assert.ok(defaultHtml.includes("github-light") && defaultHtml.includes("github-dark"), "default HTML must carry github theme names");
    // Custom uses min-light / nord
    assert.ok(customHtml.includes("min-light") && customHtml.includes("nord"), "custom HTML must carry min-light and nord theme names");

    // Check tokenLines variants colors differ
    const defaultTokenLines = defaultCode.payload.meta?.tokenLines as Array<{ spans: Array<{ v?: { dark?: { fg?: string }; light?: { fg?: string } } }> }>;
    const customTokenLines = customCode.payload.meta?.tokenLines as Array<{ spans: Array<{ v?: { dark?: { fg?: string }; light?: { fg?: string } } }> }>;
    assert.ok(defaultTokenLines && customTokenLines, "both should emit token lines");

    const defaultFirstColor = defaultTokenLines[0]?.spans[0]?.v?.dark?.fg;
    const customFirstColor = customTokenLines[0]?.spans[0]?.v?.dark?.fg;
    assert.ok(defaultFirstColor && customFirstColor, "both should have dark foreground colors");
    assert.notStrictEqual(defaultFirstColor, customFirstColor, "token colors must differ between themes");
    // In nord theme, 'const' keyword is #81A1C1; in github-dark it is #F97583
    assert.strictEqual(customFirstColor.toUpperCase(), "#81A1C1", "custom dark token color must match nord keyword color");

    defaultEngine.dispose();
    customEngine.dispose();
  }

  // Test 2: Two engines in one process with different themes do not cross-contaminate (shared cache keyed by themes)
  {
    const messagesA: WorkerOut[] = [];
    const messagesB: WorkerOut[] = [];
    const messagesC: WorkerOut[] = [];

    const engineA = new MarkdownEngine({ post: (msg) => messagesA.push(msg) });
    const engineB = new MarkdownEngine({ post: (msg) => messagesB.push(msg) });
    const engineC = new MarkdownEngine({ post: (msg) => messagesC.push(msg) });

    // Engine A: default themes
    await engineA.handle({ type: "INIT", schemaVersion: STREAM_MDX_SCHEMA_VERSION, initialContent: "",
    themes: { light: "github-light", dark: "github-dark" },
    docPlugins: { codeHighlighting: "final", outputMode: "html", lazyTokenization: { enabled: false } }, });

    // Engine B: min-light + nord
    await engineB.handle({ type: "INIT", schemaVersion: STREAM_MDX_SCHEMA_VERSION, initialContent: "",
    themes: { light: "min-light", dark: "nord" },
    docPlugins: { codeHighlighting: "final", outputMode: "html", lazyTokenization: { enabled: false } }, });

    // Verify cache keys differ for the same code and language
    const keyA = getSharedHighlightCacheKey("javascript", { light: "github-light", dark: "github-dark" }, "const x = 1;");
    const keyB = getSharedHighlightCacheKey("javascript", { light: "min-light", dark: "nord" }, "const x = 1;");
    assert.notStrictEqual(keyA, keyB, "cache keys for different themes must differ");

    // Engine A processes code block
    await engineA.handle({ type: "APPEND", text: codeInput });
    await engineA.handle({ type: "FINALIZE" });

    // Engine B processes identical code block
    await engineB.handle({ type: "APPEND", text: codeInput });
    await engineB.handle({ type: "FINALIZE" });

    const blocksA = collectBlocks(messagesA);
    const blocksB = collectBlocks(messagesB);

    const htmlA = getCodeBlock(blocksA).payload.highlightedHtml ?? "";
    const htmlB = getCodeBlock(blocksB).payload.highlightedHtml ?? "";

    assert.ok(htmlA.includes("github-dark"), "engine A must retain github-dark theme");
    assert.ok(!htmlA.includes("nord"), "engine A must not contain nord theme");
    assert.ok(htmlB.includes("nord"), "engine B must retain nord theme");
    assert.ok(!htmlB.includes("github-dark"), "engine B must not contain github-dark theme");

    // Engine C with same themes as B should hit B's cache and also get nord
    await engineC.handle({ type: "INIT", schemaVersion: STREAM_MDX_SCHEMA_VERSION, initialContent: codeInput,
    themes: { light: "min-light", dark: "nord" },
    docPlugins: { codeHighlighting: "final", outputMode: "html", lazyTokenization: { enabled: false } }, });
    await engineC.handle({ type: "FINALIZE" });

    const blocksC = collectBlocks(messagesC);
    const htmlC = getCodeBlock(blocksC).payload.highlightedHtml ?? "";
    assert.strictEqual(htmlC, htmlB, "engine C must get identical cached output as engine B without contaminating engine A");

    engineA.dispose();
    engineB.dispose();
    engineC.dispose();
  }

  // Test 3: Unknown theme reports error via existing reportError path and still renders with fallback defaults
  {
    const messages: WorkerOut[] = [];
    const engine = new MarkdownEngine({ post: (msg) => messages.push(msg) });

    await engine.handle({ type: "INIT", schemaVersion: STREAM_MDX_SCHEMA_VERSION, initialContent: "# Header\n\n```javascript\nconst valid = true;\n```\n",
    themes: { light: "this-theme-does-not-exist-xyz", dark: "nord" },
    docPlugins: { codeHighlighting: "final", outputMode: "html", lazyTokenization: { enabled: false } }, });
    await engine.handle({ type: "FINALIZE" });

    // Check that an ERROR message was reported during INIT phase
    const errorMsg = messages.find((m): m is Extract<WorkerOut, { type: "ERROR" }> => m.type === "ERROR");
    assert.ok(errorMsg, "engine must report an ERROR message for unknown theme");
    assert.strictEqual(errorMsg.phase, "INIT", "error must occur in INIT phase");
    assert.ok(errorMsg.error.message.includes("this-theme-does-not-exist-xyz"), "error message must reference unknown theme");

    // Check that INITIALIZED was still emitted and blocks rendered
    const blocks = collectBlocks(messages);
    assert.strictEqual(blocks.length, 2, "must render both heading and code block");

    const codeBlock = getCodeBlock(blocks);
    const html = codeBlock.payload.highlightedHtml ?? "";
    // Since light theme fell back to github-light, and dark theme loaded nord:
    assert.ok(html.includes("github-light"), "unknown light theme must fall back to github-light");
    assert.ok(html.includes("nord"), "valid dark theme must still be applied");

    engine.dispose();
  }
}

await runWorkerThemesTest();
console.log("worker themes tests passed");
