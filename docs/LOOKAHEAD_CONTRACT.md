# Lookahead Contract

This document defines the V1 lookahead contract for StreamMDX.

It is intentionally smaller than the broader planning packet in
`docs_tmp/LOOKAHEAD/LOOKAHEAD_V1_PLANNER_RESPONSE.md`. The goal is to freeze
the narrow waist that Phase 0 and Phase 1 will build around, without
prematurely turning every idea into a stable API.

See also:
- [`LOOKAHEAD_V1_EXECUTION_PLAN.md`](./LOOKAHEAD_V1_EXECUTION_PLAN.md)
- [`LOOKAHEAD_TRACE_WORKFLOW.md`](./LOOKAHEAD_TRACE_WORKFLOW.md)
- [`REGRESSION_TESTING.md`](./REGRESSION_TESTING.md)
- [`STREAMING_CORRECTNESS_CONTRACT.md`](./STREAMING_CORRECTNESS_CONTRACT.md)

## North Star

Lookahead is a local, validated, traceable repair transaction.

- Segmentation localizes and classifies candidate ranges.
- Providers propose bounded repairs for one surface.
- The orchestrator validates, terminates, downgrades, and traces.
- The renderer displays already-classified preview state; it does not invent repairs.

## Surface taxonomy

V1 uses these internal surfaces:

- `inline-format`
- `regex`
- `math-inline`
- `math-block`
- `html-inline`
- `html-block`
- `mdx-tag`
- `mdx-expression`

These are internal contract surfaces, not yet a public extension ABI.

## Safety classes

- `safe`
  - mechanical closure only
  - bounded tail trimming only
  - empty placeholder groups only where the syntax already requires a slot
- `guarded`
  - local structural repair that must pass validation before it can render
- `unsafe`
  - semantic guessing or unbounded capture
  - never rendered in production

## Decisions

A provider/orchestrator cycle can produce one of these decisions:

- `accept-as-is`
- `repair`
- `safe-prefix`
- `surface-fallback`
- `raw`
- `terminate`

## Downgrade modes

V1 keeps downgrade simple:

- `raw`
- `safe-prefix`
- `surface-fallback`

There is no generic "half-repaired but visibly incomplete" mode. If a surface
cannot produce a validated anticipated preview, it must downgrade explicitly.

## Termination and rearm

Termination reasons must be explicit:

- `budget-chars`
- `budget-newlines`
- `budget-nesting`
- `budget-steps`
- `validation-failed`
- `no-progress`
- `unsupported-syntax`
- `container-instability`
- `protected-range-conflict`
- `unsafe-repair-required`
- `surface-mismatch`

Terminated plans latch until a real rearm condition occurs:

- `next-byte`
- `new-delimiter`
- `newline-change`
- `container-change`
- `finalization`

No provider should retry every byte forever once it has clearly terminated for a
given `(surface, local range, container signature)` tuple.

## Container context

Providers receive normalized context, not AST objects and not sibling
references.

Minimum context for V1:

- block type
- ancestor type chain
- list depth
- blockquote depth
- `insideHtml`
- `insideMdx`
- direct inline vs mixed-content origin
- mixed segment kind when applicable
- provisional/finalized state
- `containerSignature`

The `containerSignature` exists to invalidate stale anticipation when the local
container reparses or changes type.

## Hard invariants

1. Providers operate only on their assigned local range.
2. Providers may only add tail-local closure or placeholders; they may not invent semantic payload.
3. Providers may not cross protected ranges for math, HTML, or MDX.
4. Guarded plans must pass locality validation before render.
5. A terminated plan latches until a real rearm condition occurs.
6. Container signature changes invalidate descendant anticipation state.
7. Final output must converge to the non-anticipated parse for the final source.

## V1 surface boundaries

### Inline formatting

Allowed:
- delimiter closure for emphasis/strong/strike/code

Not allowed:
- cross-line or cross-container repair
- semantic inference

### Regex

Allowed:
- existing regex anticipation behavior through a provider adapter

Not allowed:
- unbounded scan
- side effects
- provider-owned parsing outside the local range

### Math

Allowed in V1:
- tail control-word trimming
- tail-local unmatched group closure
- dangling `^` / `_` repair
- allowlisted empty-slot insertion for `\frac` and `\sqrt`

Deferred:
- macro-name inference
- environments
- `\left ... \right`
- optional-argument repair

### HTML

Allowed in V1:
- allowlisted inline tag auto-close

Default:
- block HTML anticipation is conservative and usually falls back

### MDX

Allowed in V1:
- allowlisted tag/component closure in bounded local cases
- optional brace-only trivial expression mode

Deferred:
- ambitious MDX expression repair
- broad block-component capture behavior

## Trace requirements

Every anticipation artifact should be explainable.

At minimum the trace layer must make it possible to answer:

- which surface was considered
- which provider handled the range
- what decision it made
- whether the plan was safe or guarded
- why it downgraded
- why it terminated
- when it rearms
- what the rendered HTML looked like at that step

## Current implementation status

The first contract-shaped implementation slice is now live internally.

Current landed pieces:
- `docs/LOOKAHEAD_V1_EXECUTION_PLAN.md` and this contract document
- internal contract types in `packages/markdown-v2-core/src/streaming/lookahead-contract.ts`
- a core prepare path in `packages/markdown-v2-core/src/streaming/inline-streaming.ts`
- worker metadata plumbing for `inlineLookahead`, `inlineContainerSignature`, and invalidation hints
- trace artifacts emitted by `scripts/analyze-test-snippets.ts`

Current trace artifacts include:
- provider id
- decision
- safety
- repair ops
- termination reason and `rearmWhen` when termination occurs
- container signature
- rendered HTML and block summary per step

Current limitations:
- only `inline-format` and `regex` have contract-shaped runtime paths
- HTML, MDX, and Math V1 providers are not implemented yet
- the trace workflow is canonicalized around an exported docs build plus a static server, not `next dev`

## Current no-fake-progress rule

This lookahead effort does not count fixture creation or trace output by itself as progress.

A new fixture only counts when at least one of these is true:
- it has a direct unit or integration assertion
- it has regression HTML coverage
- it has trace expectations that are stable and inspectable

A provider migration only counts when at least one of these is true:
- the decision shape is emitted into trace artifacts
- termination / downgrade behavior is visible in artifacts
- an existing legacy behavior path has been removed or unified behind the orchestrator

## What this contract is not

This is not:

- a public stable plugin ABI yet
- a provider-owned AST system
- permission to auto-heal arbitrary broken syntax
- a guarantee that every rich surface gets aggressive anticipation in V1

The purpose of V1 is to make anticipation coherent, bounded, and debuggable
before making it more ambitious.
