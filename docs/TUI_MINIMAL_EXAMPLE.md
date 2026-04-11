# Minimal TUI Example

This page is the shortest path from "I think I want the TUI/protocol surface" to a runnable local example.

Use it when you do not want to reverse-engineer the worker, snapshot-store, and terminal render loop from the larger guides.

## What this example covers

- starting the Node worker with `stream-mdx/worker/node`
- applying `PATCH` messages to the `@stream-mdx/tui` snapshot store
- rendering `Block[]` back to the terminal
- a conservative baseline for terminal consumers before you add Ink, blessed, or custom ANSI layout

## Run it

From the repo root:

```bash
npm install
npm run build:packages
npm run example:tui-minimal
```

If you prefer to run the file directly:

```bash
node examples/tui-minimal/index.mjs
```

## What the example intentionally does not do

- render arbitrary MDX components in a terminal
- ship built-in ANSI syntax highlighting
- preserve terminal scrollback
- provide a full reference TUI framework

That is deliberate. StreamMDX owns parsing, patches, and block materialization. Your terminal application owns final presentation.

## Architecture

```text
streaming markdown
        |
        v
Node worker helper (`stream-mdx/worker/node`)
        |
        v
PATCH messages
        |
        v
snapshot store (`@stream-mdx/tui`)
        |
        v
terminal renderer
```

## Core loop

```ts
import { createWorkerThread } from "stream-mdx/worker/node";
import { createSnapshotStore } from "@stream-mdx/tui";
import type { WorkerOut } from "stream-mdx/core";

const worker = createWorkerThread({ stdout: true, stderr: true });
const store = createSnapshotStore();

worker.on("message", (msg: WorkerOut) => {
  if (msg.type !== "PATCH") return;
  store.applyPatches(msg.patches);
  renderToTerminal(store.getBlocks());
});

worker.postMessage({
  type: "INIT",
  initialContent: "",
  docPlugins: { tables: true, html: true, mdx: true, math: true, footnotes: true },
  mdx: { compileMode: "worker" },
});

worker.postMessage({ type: "APPEND", text: "# Hello\n\nStreaming **markdown** in a TUI.\n" });
worker.postMessage({ type: "FINALIZE" });
```

## When to move on from this example

Once this loop works locally, use the next docs in this order:

1. [`TUI_GUIDE.md`](./TUI_GUIDE.md) for the recommended runtime and store choices
2. [`CLI_USAGE.md`](./CLI_USAGE.md) for lower-level Node runtime details
3. [`STREAMMDX_JSON_DIFF_SPEC.md`](./STREAMMDX_JSON_DIFF_SPEC.md) if you actually need a transport boundary

## Related files

- [`../examples/tui-minimal/README.md`](../examples/tui-minimal/README.md)
- [`../examples/tui-minimal/index.mjs`](../examples/tui-minimal/index.mjs)
- [`TUI_GUIDE.md`](./TUI_GUIDE.md)
