# `@stream-mdx/tui`

`@stream-mdx/tui` provides terminal-oriented helpers for StreamMDX protocol streams: NDJSON encoding/decoding and a lightweight snapshot store that can apply events and materialize blocks outside React.

## Install

```bash
npm install @stream-mdx/tui @stream-mdx/protocol @stream-mdx/core
```

## Main Capabilities

| Capability | Notes |
| --- | --- |
| NDJSON helpers | Encode/decode protocol events for line-oriented transports |
| Snapshot store | Apply patch streams and recover block state |
| Non-React usage | Useful in TUIs, CLIs, log viewers, and replay tools |

## NDJSON Snapshot Store

```ts
import { NdjsonDecoder, createSnapshotStore } from "@stream-mdx/tui";
import type { StreamMdxEvent } from "@stream-mdx/protocol";

const decoder = new NdjsonDecoder<StreamMdxEvent>();
const store = createSnapshotStore();

export function receiveChunk(chunk: string | Uint8Array) {
  store.applyEvents(decoder.push(chunk));
  return store.getBlocks();
}
```

Every schema-2 event carries the producer's native document `generation`. Publish `init` and the matching `INITIALIZED` snapshot before patches; the snapshot's canonical input generation must match its event envelope. Do not infer a baseline from the first patch. The store rejects stale or foreign-stream events, clears generation-local transaction/status metadata on replacement, and accepts `done` only for the bound generation.

`setSnapshot(Block[])` is a cold replacement: it retires the previous native transport generation without inventing a new one. A later validated, newer baseline can resume live events. Direct `applyPatches()` remains caller-owned and does not infer transport ownership.

## Notes

- Token output depends on the worker output mode (`tokens` or `both`).
- The store is intentionally lightweight and aimed at non-React consumers.

## Documentation

- Run the example locally with `npm run example:tui-minimal` from the repo root.
- [`../../examples/tui-minimal/README.md`](../../examples/tui-minimal/README.md)
- [`../../docs/TUI_MINIMAL_EXAMPLE.md`](../../docs/TUI_MINIMAL_EXAMPLE.md)
- [`../../docs/TUI_GUIDE.md`](../../docs/TUI_GUIDE.md)
- [`../../docs/CLI_USAGE.md`](../../docs/CLI_USAGE.md)
- [`../../docs/STREAMMDX_JSON_DIFF_SPEC.md`](../../docs/STREAMMDX_JSON_DIFF_SPEC.md)
- [`../../docs/PUBLIC_API.md`](../../docs/PUBLIC_API.md)
