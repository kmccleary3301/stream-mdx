# Terminal protocol flow

This showcase covers the non-React path that is easy to miss if you only look at the browser demo. StreamMDX is not just a React renderer. It also exposes a worker, protocol surface, and snapshot-store model that works for terminal UIs, remote transports, and replay tooling.

## What this showcases

- worker-thread parsing in Node
- snapshot materialization outside React
- protocol/event transport for process boundaries
- a concrete repo example you can run immediately

## Recommended architecture

Use this shape when your consumer is a TUI, CLI, log viewer, or replay tool:

```text
markdown stream
    |
    v
worker helper (`stream-mdx/worker/node`)
    |
    v
PATCH / event output
    |
    v
snapshot store (`@stream-mdx/tui`)
    |
    v
terminal renderer (Ink / blessed / custom ANSI)
```

This keeps parsing semantics aligned with the browser path while giving the terminal consumer full control over layout.

## Minimal runnable example

The repo now includes a minimal end-to-end example:

- [Repo example README](/docs/tui-guide)
- [GitHub example file](https://github.com/kmccleary3301/stream-mdx/blob/main/examples/tui-minimal/index.mjs)

From the repo root:

```bash
npm install
npm run build:packages
node examples/tui-minimal/index.mjs
```

That example does four things only:

1. starts the worker in Node
2. appends streaming markdown in chunks
3. applies patches to the TUI snapshot store
4. renders `Block[]` back to the terminal

## Worker + snapshot-store loop

```ts
import { createWorkerThread } from "stream-mdx/worker/node";
import { createSnapshotStore } from "@stream-mdx/tui";

const worker = createWorkerThread({ stdout: true, stderr: true });
const store = createSnapshotStore();

worker.on("message", (msg) => {
  if (msg.type === "PATCH") {
    store.applyPatches(msg.patches);
    renderToTerminal(store.getBlocks());
  }
});

worker.postMessage({
  type: "INIT",
  initialContent: "",
  docPlugins: { tables: true, html: true, mdx: false, math: false, footnotes: true },
  mdx: { compileMode: "server" },
});
```

## When protocol transport matters

You do **not** need `@stream-mdx/protocol` when everything lives inside one local Node process.

You **do** want it when:

- the parser and renderer live in different processes
- you want NDJSON over a socket or subprocess pipe
- you want replayable structured event logs
- you need a typed boundary that is not tied directly to worker message objects

```ts
import { NdjsonDecoder, createSnapshotStore } from "@stream-mdx/tui";
import type { StreamMdxEventV1 } from "@stream-mdx/protocol";

const decoder = new NdjsonDecoder<StreamMdxEventV1>();
const store = createSnapshotStore();

for (const event of decoder.push(chunk)) {
  store.applyEvent(event);
}
```

## Capability boundaries

This surface is already strong for:

- block snapshots
- replay tooling
- terminal rendering from `Block[]`
- structured event transport

It is intentionally still lightweight for:

- arbitrary MDX component rendering in a terminal
- built-in ANSI syntax-highlighting helpers
- a full reference terminal UI beyond the repo example

That boundary is deliberate. The library owns parsing and patch semantics; the terminal consumer owns final presentation.

## Operational checklist

If you are shipping a TUI or protocol consumer, treat these as the default checklist:

- prefer `createWorkerThread()` over a direct compile path when `worker_threads` are available
- render from `Block[]`, not from raw HTML
- keep MDX handling explicit and conservative in terminals
- use the protocol path only when you actually have a transport boundary
- keep regression and replay fixtures for any custom terminal formatting logic

## Related docs

- [TUI guide](/docs/tui-guide)
- [TUI / JSON protocol](/docs/tui-json-protocol)
- [Comprehensive manual](/docs/manual)
- [Public API](/docs/public-api)
