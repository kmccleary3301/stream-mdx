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

## NDJSON Example

```ts
import { NdjsonDecoder, encodeNdjsonEvent } from "@stream-mdx/tui";

const decoder = new NdjsonDecoder();
const chunk = encodeNdjsonEvent({ event: "done" } as any);
const events = decoder.push(chunk);
```

## Snapshot Store Example

```ts
import { createSnapshotStore } from "@stream-mdx/tui";

const store = createSnapshotStore();
store.applyEvents(events);
const blocks = store.getBlocks();
```

## Notes

- Token output depends on the worker output mode (`tokens` or `both`).
- The store is intentionally lightweight and aimed at non-React consumers.

## Documentation

- [`../../docs/TUI_GUIDE.md`](../../docs/TUI_GUIDE.md)
- [`../../docs/CLI_USAGE.md`](../../docs/CLI_USAGE.md)
- [`../../docs/STREAMMDX_JSON_DIFF_SPEC.md`](../../docs/STREAMMDX_JSON_DIFF_SPEC.md)
- [`../../docs/PUBLIC_API.md`](../../docs/PUBLIC_API.md)
