# CLI / Node Usage

StreamMDX is designed for browser + React, but the worker-first architecture makes it easy to reuse the same parsing and patch stream in non-browser runtimes (e.g. Ink-based TUIs).

This doc covers:

- Running the StreamMDX worker in **Node** via `worker_threads`
- Consuming `PATCH` messages to maintain a `DocumentSnapshot`
- Running deterministic compile without `worker_threads` (edge-style runtime)
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

## 1b) Static compile helper (snapshot artifact)

If you want a **one-shot compile** (SSG/SSR precompute), use the Node helper that wraps
`worker_threads` and returns a deterministic snapshot with optional file caching:

```ts
import { compileMarkdownSnapshot } from "stream-mdx/worker/node";

const result = await compileMarkdownSnapshot({
  text: "# Hello\\n\\n```ts\\nconsole.log('hi')\\n```",
  init: {
    docPlugins: { tables: true, html: true, mdx: true, math: true, footnotes: true },
    mdx: { compileMode: "server" },
    prewarmLangs: ["typescript"],
  },
  cache: {
    dir: ".stream-mdx-cache",
  },
});

console.log(result.blocks);
// result.snapshot holds the full DocumentSnapshot if you need it.
```

Notes:

- `compileMarkdownSnapshot` waits for the worker to finalize and returns stable `blocks`.
- The cache is keyed by a hash of `text + init` unless you provide `cache.key`.

## 1c) Direct compile helper (no `worker_threads`)

If your runtime cannot spawn `worker_threads`, use the in-process direct helper:

```ts
import { compileMarkdownSnapshotDirect } from "stream-mdx/worker/direct";

const result = await compileMarkdownSnapshotDirect({
  text: "# Edge-safe compile\\n\\n```ts\\nexport const answer = 42;\\n```",
  init: {
    docPlugins: { tables: true, html: true, mdx: true, math: true, footnotes: true },
    mdx: { compileMode: "server" },
    prewarmLangs: ["typescript"],
  },
  hashSalt: "edge-preview",
  cache: {
    dir: ".stream-mdx-cache",
  },
});

console.log(result.blocks);
```

Notes:

- This path keeps determinism parity with `compileMarkdownSnapshot` for the same input/init.
- It is currently a preview API intended for runtimes where worker threads are unavailable.
- Filesystem cache parity is supported when the runtime exposes Node filesystem APIs.
- In runtimes without filesystem access (for example most edge isolates), direct compile still works and simply skips cache reads/writes (`fromCache` remains `false`).

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

## 6) Diff tokens → ANSI (minimal example)

When using the worker, enable token output and (optionally) diff blocks:

```ts
docPlugins: {
  outputMode: "tokens",
  emitHighlightTokens: true,
  emitDiffBlocks: true,
  liveTokenization: false, // final-only tokens by default
}
```

Then render `code-line` nodes with `diffKind`, `oldNo`, `newNo`, and `tokens`:

```ts
import type { TokenLineV1, DiffKind } from "@stream-mdx/core";

const ANSI_RESET = "\u001b[0m";
const BG_ADD = "\u001b[42m";
const BG_DEL = "\u001b[41m";

function fg(hex?: string | null): string {
  if (!hex) return "";
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `\u001b[38;2;${r};${g};${b}m`;
}

function renderTokenLine(tokens: TokenLineV1 | null): string {
  if (!tokens) return "";
  return tokens.spans
    .map((span) => {
      const color = span.s?.fg ?? span.v?.dark?.fg ?? span.v?.light?.fg ?? null;
      return `${fg(color)}${span.t}`;
    })
    .join("");
}

function renderDiffLine(text: string, tokens: TokenLineV1 | null, kind?: DiffKind | null): string {
  const bg = kind === "add" ? BG_ADD : kind === "remove" ? BG_DEL : "";
  return `${bg}${renderTokenLine(tokens) || text}${ANSI_RESET}`;
}
```

Notes:
- `tokens` is **foreground only**; background stays transparent so the TUI can decide.
- For diff fences, StreamMDX also emits `diffKind`, `oldNo`, `newNo` per line.
- If you enable `emitDiffBlocks`, you can also read `block.payload.meta.diffBlocks` for structured per-file diffs.
