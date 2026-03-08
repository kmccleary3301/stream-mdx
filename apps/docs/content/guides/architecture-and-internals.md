# Architecture and Internals

This is a high-level map of the StreamMDX pipeline and the decisions that keep streaming fast while preserving output correctness.

## Pipeline overview

1. **Worker ingestion**: content arrives in chunks; the worker parses and emits patches.
2. **Block enrichment**: inline parsing, math detection, and HTML/MDX detection happen at block level.
3. **Patch coalescing**: patches are merged into minimal operations.
4. **React render**: patches update the renderer store, then the React tree.

## Patch coalescing

StreamMDX consolidates patch operations to reduce DOM work per tick. The goal is to keep queue depth low and avoid re-rendering stable nodes.

## Renderer store

The renderer store holds a normalized tree of nodes (blocks + children). It supports:

- Deterministic patch application
- List depth normalization
- Snapshot caching for React rendering

## Streaming invariants

The regression harness enforces invariants that catch drift:

- **Root child count** should never decrease during streaming.
- **Final HTML** should not contain raw math or raw backticks.
- **Sanitization** removes script handlers and unsafe tags.

## MDX and HTML boundaries

MDX compilation is decoupled from core markdown parsing:

- HTML/MDX is segmented into mixed content blocks.
- MDX blocks can be compiled in the worker or server.
- Inline protected ranges prevent false MDX detection inside code/math.

## Scheduling and backpressure

The scheduler controls when patches flush:

- **Aggressive**: prioritizes low latency.
- **Smooth**: prioritizes frame pacing.

Backpressure is exposed via metrics and can be tuned for high-volume streams.
