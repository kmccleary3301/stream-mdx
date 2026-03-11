# `@stream-mdx/protocol`

`@stream-mdx/protocol` defines the transport-facing protocol types for structured StreamMDX event/object streaming. It is intended for consumers that need a stable, typed contract outside the React/browser UI layer.

Typical consumers include:

- TUIs and CLI tools
- NDJSON transports
- service boundaries that want typed event envelopes
- debugging or replay tooling that records and replays structured patch streams

## Install

```bash
npm install @stream-mdx/protocol
```

## What This Package Provides

| Surface | Purpose |
| --- | --- |
| Event envelope types | Transport-safe event/message contracts |
| Capability metadata | Describe supported features or modes |
| Token/block payload types | Structured-clone-safe payload shapes |

## Typical Pairings

| Pair with | Why |
| --- | --- |
| [`@stream-mdx/tui`](../markdown-v2-tui/README.md) | NDJSON helpers and snapshot store |
| [`@stream-mdx/core`](../markdown-v2-core/README.md) | Shared low-level types and helpers |
| [`@stream-mdx/worker`](../markdown-v2-worker/README.md) | Worker-side generation/consumption paths |

## Documentation

- [`../../docs/TUI_GUIDE.md`](../../docs/TUI_GUIDE.md)
- [`../../docs/STREAMMDX_JSON_DIFF_SPEC.md`](../../docs/STREAMMDX_JSON_DIFF_SPEC.md)
- [`../../docs/CLI_USAGE.md`](../../docs/CLI_USAGE.md)
- [`../../docs/PUBLIC_API.md`](../../docs/PUBLIC_API.md)
