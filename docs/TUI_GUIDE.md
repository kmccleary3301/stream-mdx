# TUI Guide

This guide is the first entry point for using StreamMDX in terminal and non-React environments.

If you are building an Ink app, a CLI viewer, a log console, or another text-first interface, the recommended model is:

1. run the StreamMDX worker in Node, or use direct compile
2. maintain a snapshot store
3. render `Block[]` into your own terminal components

This document focuses on architecture and practical setup. For lower-level protocol details, see [`STREAMMDX_JSON_DIFF_SPEC.md`](./STREAMMDX_JSON_DIFF_SPEC.md). For Node/CLI runtime details and raw worker examples, see [`CLI_USAGE.md`](./CLI_USAGE.md).

## What To Install

### Recommended TUI stack

```bash
npm install stream-mdx @stream-mdx/tui @stream-mdx/protocol
```

This gives you:

| Package | Why you want it |
| --- | --- |
| `stream-mdx` | Stable convenience import paths for worker helpers |
| `@stream-mdx/tui` | Snapshot store and NDJSON helpers |
| `@stream-mdx/protocol` | Stable event-envelope types when you want structured transports |

### Lower-level / explicit install

```bash
npm install @stream-mdx/worker @stream-mdx/core @stream-mdx/tui @stream-mdx/protocol
```

Use this when you want the worker/runtime pieces explicitly instead of the convenience wrapper.

## Pick The Right Runtime Path

| Situation | Recommended API | Why |
| --- | --- | --- |
| Local CLI or TUI on Node | `stream-mdx/worker/node` | Best default. Reuses the hosted worker bundle under `worker_threads`. |
| Static one-shot compile in Node | `stream-mdx/worker/node` + `compileMarkdownSnapshot()` | Good for precompute, cacheable snapshots, and deterministic offline transforms. |
| Runtime without `worker_threads` | `stream-mdx/worker/direct` | In-process fallback when `worker_threads` are unavailable. |
| Line-oriented transport / remote stream | `@stream-mdx/protocol` + `@stream-mdx/tui` | Useful when you want NDJSON or a process boundary between producer and renderer. |

## Recommended Architecture

For most TUIs, use this architecture:

```text
markdown source / stream
        |
        v
Node worker helper (`stream-mdx/worker/node`)
        |
        v
`PATCH` messages
        |
        v
snapshot store (`@stream-mdx/tui` or core snapshot utilities)
        |
        v
your terminal renderer (Ink / blessed / custom ANSI renderer)
```

This gives you:

- the same worker-first parsing model used by the browser renderer
- stable `Block[]` output for terminal rendering
- optional access to low-level patch data when you need richer state handling

## Quickstart: Minimal Streaming TUI Loop

This is the smallest useful architecture for a Node-based TUI.

```ts
import { createWorkerThread } from "stream-mdx/worker/node";
import { createSnapshotStore } from "@stream-mdx/tui";
import type { WorkerOut } from "stream-mdx/core";

const worker = createWorkerThread({ stdout: true, stderr: true });
const store = createSnapshotStore();

worker.on("message", (msg: WorkerOut) => {
  if (msg.type === "PATCH") {
    store.applyPatches(msg.patches);
    const blocks = store.getBlocks();
    renderToTerminal(blocks);
    return;
  }

  if (msg.type === "ERROR") {
    console.error(msg.message);
  }
});

worker.postMessage({
  type: "INIT",
  initialContent: "",
  prewarmLangs: ["typescript"],
  docPlugins: {
    tables: true,
    html: true,
    mdx: true,
    math: true,
    footnotes: true,
  },
  mdx: { compileMode: "worker" },
});

worker.postMessage({ type: "APPEND", text: "# Hello\n\nStreaming **markdown** in a TUI.\n" });
worker.postMessage({ type: "FINALIZE" });

function renderToTerminal(blocks: ReturnType<typeof store.getBlocks>) {
  process.stdout.write("\x1bc");
  for (const block of blocks) {
    if (block.type === "heading") {
      process.stdout.write(`# ${block.payload.raw}\n\n`);
      continue;
    }
    process.stdout.write(`${block.payload.raw}\n\n`);
  }
}
```

## Snapshot Store Choices

There are two reasonable ways to maintain terminal state:

| Option | Use when | API |
| --- | --- | --- |
| `createSnapshotStore()` from `@stream-mdx/tui` | You want the simplest TUI-facing store | `applyPatches()`, `applyEvent()`, `getBlocks()` |
| Core snapshot utilities | You want lower-level control | `createInitialSnapshot()`, `applyPatchBatch()` |

### TUI store

```ts
import { createSnapshotStore } from "@stream-mdx/tui";

const store = createSnapshotStore();
store.applyPatches(patches);
const blocks = store.getBlocks();
```

### Core snapshot utilities

```ts
import { applyPatchBatch, createInitialSnapshot } from "stream-mdx/core";

const snapshot = createInitialSnapshot();
snapshot.blocks = applyPatchBatch(snapshot, patches);
```

Use the core path only when you need direct access to `DocumentSnapshot` internals. For most terminal apps, the TUI store is the cleaner choice.

## Rendering Strategy In A Terminal

You do not need to reproduce the React renderer. The stable strategy is:

| Block type | Suggested terminal treatment |
| --- | --- |
| `heading` | Prefix with `#`, `##`, etc. and use ANSI emphasis if desired |
| `paragraph` | Render inline text and wrap lines to your terminal width |
| `blockquote` | Prefix with `>` or a vertical bar marker |
| `list` / `list-item` | Render bullets or ordered markers in your own layout |
| `code` | Render raw text, or tokenized output if you use token mode |
| `table` | Flatten to a simple ASCII/Unicode grid or a stacked mobile-style layout |
| `html` | Usually treat as text or a sanitized textual fallback |
| `mdx` | Treat as opaque unless you have your own terminal representation |
| `footnotes` | Render in a trailing footnote section |

The key point is that StreamMDX gives you structured blocks and patches. Terminal layout is your responsibility.

## Static / One-Shot Compile

If you do not need incremental streaming and only want deterministic block output for a CLI command, use `compileMarkdownSnapshot()`.

```ts
import { compileMarkdownSnapshot } from "stream-mdx/worker/node";

const result = await compileMarkdownSnapshot({
  text: "# Report\n\n| Model | Latency |\n| --- | --- |\n| A | 12ms |\n",
  init: {
    docPlugins: {
      tables: true,
      html: true,
      mdx: true,
      math: true,
      footnotes: true,
    },
    mdx: { compileMode: "server" },
    prewarmLangs: ["typescript"],
  },
  cache: {
    dir: ".stream-mdx-cache",
  },
});

renderToTerminal(result.blocks);
```

This is a good fit for:

- report generators
- offline previews
- static export pipelines
- terminal tools that do not need live chunk-by-chunk updates

## Direct Compile Without `worker_threads`

If your runtime cannot spawn `worker_threads`, use the direct compile helper:

```ts
import { compileMarkdownSnapshotDirect } from "stream-mdx/worker/direct";

const result = await compileMarkdownSnapshotDirect({
  text: "# Edge-safe compile\n\n`worker_threads` not required.\n",
  init: {
    docPlugins: {
      tables: true,
      html: true,
      mdx: true,
      math: true,
      footnotes: true,
    },
    mdx: { compileMode: "server" },
  },
});
```

Tradeoff:

- simpler runtime requirements
- weaker isolation than a real worker thread

## When To Use The Protocol Package

If your terminal consumer lives in a different process, machine, or transport boundary, switch from raw `WorkerOut` messages to the protocol/event model.

Recommended pattern:

1. producer emits `StreamMdxEventV1`
2. transport carries NDJSON
3. consumer decodes NDJSON with `NdjsonDecoder`
4. consumer applies events to `createSnapshotStore()`

```ts
import { NdjsonDecoder, createSnapshotStore } from "@stream-mdx/tui";
import type { StreamMdxEventV1 } from "@stream-mdx/protocol";

const decoder = new NdjsonDecoder<StreamMdxEventV1>();
const store = createSnapshotStore();

for (const event of decoder.push(chunk)) {
  store.applyEvent(event);
}
```

Use this model when:

- you want a versioned event contract
- you want replayable logs
- you want producer/consumer separation
- you do not want to couple your TUI directly to the worker message shape

## Tokens, Diffs, and ANSI

For simple TUIs, rendering `block.payload.raw` is often enough.

For richer terminals:

- use token output for syntax-highlighted code
- use `diffKind`, `oldNo`, and `newNo` for diff-aware rendering
- map token colors to ANSI yourself, or through your terminal framework

The relevant lower-level references are:

- [`CLI_USAGE.md`](./CLI_USAGE.md)
- [`STREAMMDX_JSON_DIFF_SPEC.md`](./STREAMMDX_JSON_DIFF_SPEC.md)

## Practical Recommendations

1. Start with `createWorkerThread()` plus `createSnapshotStore()`.
2. Render from `Block[]`, not from raw HTML.
3. Treat MDX and HTML blocks as special cases with explicit fallback policy.
4. Use `compileMarkdownSnapshot()` when you do not need live incremental streaming.
5. Use the protocol/NDJSON path only when you actually have a transport boundary.

## Related Docs

- [`CLI_USAGE.md`](./CLI_USAGE.md)
- [`STREAMMDX_JSON_DIFF_SPEC.md`](./STREAMMDX_JSON_DIFF_SPEC.md)
- [`PUBLIC_API.md`](./PUBLIC_API.md)
- [`DETERMINISM.md`](./DETERMINISM.md)
