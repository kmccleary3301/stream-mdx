# @stream-mdx/tui

Reference utilities for terminal and CLI integrations.

## Features
- NDJSON encoder/decoder helpers for StreamMDX protocol events.
- Lightweight snapshot store that applies patches and yields blocks.

## Install
```bash
npm install @stream-mdx/tui @stream-mdx/core @stream-mdx/protocol
```

## NDJSON
```ts
import { NdjsonDecoder, encodeNdjsonEvent } from "@stream-mdx/tui";

const decoder = new NdjsonDecoder();
const chunk = encodeNdjsonEvent({ event: "done" } as any);
const events = decoder.push(chunk);
```

## Snapshot Store
```ts
import { createSnapshotStore } from "@stream-mdx/tui";

const store = createSnapshotStore();
store.applyEvents(events);
const blocks = store.getBlocks();
```

## Notes
- Token output is gated by the worker output mode ("tokens" or "both").
- The store is intended for non-React environments (TUIs, CLIs).

## Docs

- CLI usage: https://github.com/kmccleary3301/stream-mdx/blob/main/docs/CLI_USAGE.md
- Protocol spec: https://github.com/kmccleary3301/stream-mdx/blob/main/docs/STREAMMDX_JSON_DIFF_SPEC.md
- Public API: https://github.com/kmccleary3301/stream-mdx/blob/main/docs/PUBLIC_API.md
