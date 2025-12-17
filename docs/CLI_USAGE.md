# CLI / Node Usage

StreamMDX is designed for browser + React, but the worker-first architecture makes it easy to reuse the same parsing and patch stream in non-browser runtimes (e.g. Ink-based TUIs).

This doc covers:

- Running the StreamMDX worker in **Node** via `worker_threads`
- Consuming `PATCH` messages to maintain a `DocumentSnapshot`
- Rendering snapshots with a terminal renderer (Ink, etc.)

## 1) Run the worker in Node (recommended helper)

Use the Node helper, which spawns a `worker_threads` worker and installs WebWorker-compatible shims (`self`, `postMessage`, `onmessage`) so the **hosted browser bundle** can run under Node.

```ts
import { createWorkerThread } from "stream-mdx/worker/node";
import { applyPatchBatch, createInitialSnapshot, type WorkerOut } from "stream-mdx/core";

const worker = createWorkerThread({ stdout: true, stderr: true });
let snapshot = createInitialSnapshot();

worker.on("message", (msg: WorkerOut) => {
  if (msg.type === "PATCH") {
    snapshot.blocks = applyPatchBatch(snapshot, msg.patches);
  }
});

worker.postMessage({
  type: "INIT",
  initialContent: "",
  prewarmLangs: ["typescript"],
  docPlugins: { tables: true, html: true, mdx: true, math: true, footnotes: true },
  mdx: { compileMode: "worker" },
});

worker.postMessage({ type: "APPEND", text: "## Hello\\n\\nStreaming **markdown**" });
worker.postMessage({ type: "FINALIZE" });
```

Notes:

- `snapshot.blocks` is an ordered `Block[]` representation suitable for rendering in a TUI.
- If you want to render the full node tree (not just blocks), inspect `snapshot.nodes` from `createInitialSnapshot()` / `applyPatchBatch()`.

## 2) Hosted worker bundle location (for advanced setups)

The self-contained hosted worker bundle is shipped in this package:

- `node_modules/@stream-mdx/worker/dist/hosted/markdown-worker.js`

If you are using Node 20+, you can resolve it via package exports:

```ts
const url = import.meta.resolve("@stream-mdx/worker/hosted/markdown-worker.js");
```

Most consumers should prefer `createWorkerThread()` so you don’t have to write the shims yourself.

## 3) Feeding Ink (or other TUI renderers)

At a high level:

1. Create and own a `DocumentSnapshot` (`createInitialSnapshot()`).
2. Apply each `PATCH` batch (`applyPatchBatch()`).
3. Render `snapshot.blocks` into your terminal UI.

For streaming, treat the markdown input as append-only and send `APPEND` messages as chunks arrive.

## 4) Message protocol (overview)

Messages sent **to** the worker (`WorkerIn`) include:

- `INIT` (initial content, plugin toggles, MDX compile mode)
- `APPEND` (append-only streaming text)
- `FINALIZE` (finalize blocks once the stream ends)
- `SET_CREDITS` (optional backpressure control)

Messages received **from** the worker (`WorkerOut`) include:

- `PATCH` (apply these patches to your snapshot)
- `METRICS` (optional performance telemetry)
- `ERROR` (worker-side errors; treat as fatal or surface to logs)

## 5) Shiki diff highlighting (roadmap note)

StreamMDX currently uses Shiki inside the worker to produce **HTML** syntax highlighting for markdown code blocks.

For CLI UIs that need ANSI-colored diffs:

- **Today**: use Shiki directly (e.g. highlight unified diffs as language `"diff"`), or implement a small adapter that converts Shiki tokens to ANSI in your TUI.
- **Potential future addition**: a dedicated helper (likely a separate package) that produces Shiki-tokenized diff segments and/or ANSI output without pulling React into CLI builds.
