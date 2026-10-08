import assert from "node:assert";
import type { Patch, WorkerIn, WorkerOut } from "@stream-mdx/core";
import { createRendererStore } from "../../markdown-v2-react/src/renderer/store";
import { JSDOM } from "jsdom";
import { createInlineEngineWorker } from "../src/engine/index";
import { createWorkerThread } from "../src/node/index";

function ensureDom(): void {
  if (typeof (globalThis as { window?: unknown }).window !== "undefined") {
    return;
  }
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  (globalThis as any).window = dom.window;
  (globalThis as any).document = dom.window.document;
  (globalThis as any).HTMLElement = dom.window.HTMLElement;
  (globalThis as any).Node = dom.window.Node;
}

const FIXTURE = `# Section Heading

Here is a paragraph with a footnote[^ref] and **bold** text.

- First item
- Second item
- Third item

| Name | Score |
| :--- | :--- |
| Alice | 100 |
| Bob | 85 |

\`\`\`ts
function add(a: number, b: number): number {
  return a + b;
}
\`\`\`

[^ref]: Footnote definition content.
`;

function runWorkerStream(
  worker: {
    postMessage: (msg: WorkerIn) => void;
    onMessage: (handler: (msg: WorkerOut) => void) => void;
  },
  fixture: string,
  chunkSize: number,
): Promise<{ store: ReturnType<typeof createRendererStore>; messages: WorkerOut[] }> {
  return new Promise((resolve, reject) => {
    ensureDom();
    const store = createRendererStore();
    const messages: WorkerOut[] = [];
    let hasFinalized = false;

    worker.onMessage((msg) => {
      messages.push(msg);
      if (msg.type === "INITIALIZED") {
        store.reset(msg.blocks);
      } else if (msg.type === "PATCH") {
        store.applyPatches(msg.patches as Patch[], { captureMetrics: false });
        const hasFinalizeOp = (msg.patches as Patch[]).some((p) => p.op === "finalize");
        if (hasFinalizeOp && !hasFinalized) {
          hasFinalized = true;
          const blocks = store.getBlocks();
          if (blocks.length > 0 && blocks.every((b) => b.isFinalized)) {
            resolve({ store, messages });
          }
        }
      } else if (msg.type === "ERROR") {
        reject(new Error(`Worker error: ${msg.error.message}`));
      }
    });

    const initMsg: WorkerIn = {
      type: "INIT",
      initialContent: "",
      prewarmLangs: ["ts", "typescript"],
      docPlugins: ["footnotes", "tables"],
    };
    worker.postMessage(initMsg);

    for (let i = 0; i < fixture.length; i += chunkSize) {
      worker.postMessage({ type: "APPEND", text: fixture.slice(i, i + chunkSize) });
    }

    worker.postMessage({ type: "FINALIZE" });
  });
}

async function runParityTest(): Promise<void> {
  ensureDom();
  const inlineWorker = createInlineEngineWorker();
  const threadWorker = createWorkerThread({ stdout: true, stderr: true });

  try {
    const chunkSize = 20;

    const inlinePromise = runWorkerStream(
      {
        postMessage: (msg) => inlineWorker.postMessage(msg),
        onMessage: (handler) => {
          inlineWorker.onmessage = (e: MessageEvent<WorkerOut>) => handler(e.data);
        },
      },
      FIXTURE,
      chunkSize,
    );

    const threadPromise = runWorkerStream(
      {
        postMessage: (msg) => threadWorker.postMessage(msg),
        onMessage: (handler) => {
          threadWorker.on("message", handler);
        },
      },
      FIXTURE,
      chunkSize,
    );

    const [inlineResult, threadResult] = await Promise.all([inlinePromise, threadPromise]);

    const inlineBlocks = inlineResult.store.getBlocks();
    const threadBlocks = threadResult.store.getBlocks();

    // Verify all 5 expected block types are present
    const types = inlineBlocks.map((b) => b.type);
    assert.ok(types.includes("heading"), "missing heading block");
    assert.ok(types.includes("paragraph"), "missing paragraph block");
    assert.ok(types.includes("list"), "missing list block");
    assert.ok(types.includes("table"), "missing table block");
    assert.ok(types.includes("code"), "missing code block");
    assert.ok(types.includes("footnotes"), "missing footnotes block");

    // All blocks must be finalized
    assert.ok(inlineBlocks.every((b) => b.isFinalized), "all inline blocks must be finalized");
    assert.ok(threadBlocks.every((b) => b.isFinalized), "all thread blocks must be finalized");

    // Assert that the streamed output (final blocks) deep-equals between inline and hosted worker
    assert.deepStrictEqual(
      inlineBlocks,
      threadBlocks,
      "inline worker output must deep-equal real worker_threads hosted worker",
    );

    // Verify initial message was emitted by both
    const inlineInit = inlineResult.messages.find((m) => m.type === "INITIALIZED");
    const threadInit = threadResult.messages.find((m) => m.type === "INITIALIZED");
    assert.ok(inlineInit, "inline worker missing INITIALIZED message");
    assert.ok(threadInit, "thread worker missing INITIALIZED message");
    assert.deepStrictEqual(inlineInit.blocks, threadInit.blocks, "initial blocks must match");

    // Verify neither worker produced errors
    assert.strictEqual(
      inlineResult.messages.some((m) => m.type === "ERROR"),
      false,
      "inline worker should not produce errors",
    );
    assert.strictEqual(
      threadResult.messages.some((m) => m.type === "ERROR"),
      false,
      "thread worker should not produce errors",
    );
  } finally {
    inlineWorker.terminate();
    await threadWorker.terminate();
  }
}

runParityTest()
  .then(() => {
    console.log("inline worker parity test passed");
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
