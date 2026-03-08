# @stream-mdx/protocol

Protocol types for StreamMDX JSON/object streaming.

This package defines the event envelope, capability metadata, and token
structures used by StreamMDX Protocol v1. It is intended for consumers that
need a stable, versioned contract (e.g., terminal UIs).

Most web-only consumers do not need this package directly. Start with `stream-mdx`
or `@stream-mdx/react` for the React renderer.

## Install

```bash
npm install @stream-mdx/protocol
```

## What this provides

- Shared protocol types for streaming events and capability negotiation.
- Token / block payload shapes intended for structured-clone-safe transport.

## Typical usage (TUI/CLI)

Pair it with `@stream-mdx/tui` for NDJSON helpers + a lightweight snapshot store:

```bash
npm install @stream-mdx/tui @stream-mdx/protocol @stream-mdx/core
```

## Docs

- Public API: https://github.com/kmccleary3301/stream-mdx/blob/main/docs/PUBLIC_API.md
- CLI usage: https://github.com/kmccleary3301/stream-mdx/blob/main/docs/CLI_USAGE.md
- Protocol spec: https://github.com/kmccleary3301/stream-mdx/blob/main/docs/STREAMMDX_JSON_DIFF_SPEC.md
