# Lookahead V1 Execution Plan

Repo anchor:
- repo: `stream-mdx`
- branch: `main`
- planner input anchor: `6f0d03c2732f654063d91e1029db66ba37bd33a8`
- source planner response: `docs_tmp/LOOKAHEAD/LOOKAHEAD_V1_PLANNER_RESPONSE.md`

This is the repo-local execution plan and closeout record for Lookahead V1.
It is intentionally narrower than the planner response. The planner gave the architectural direction; this document records the bounded V1 contract that actually shipped in StreamMDX.

## North Star

Make lookahead a local, validated, traceable repair transaction with:
- explicit provider ownership
- explicit container context
- explicit safety class
- explicit termination and rearm rules
- explicit downgrade behavior

The renderer should never invent repairs. Segmentation should localize and classify. Providers should propose bounded repairs. The orchestrator should validate, terminate, downgrade, and trace.

## What This Plan Is Trying To Fix

Current anticipation behavior is real but fragmented:
- inline delimiter closure exists
- regex append hooks exist
- worker safe-prefix fallback exists
- bounded HTML/MDX mixed-content auto-close exists
- some nested list anticipation works
- math is still mostly delimiter closure rather than bounded structural repair

The missing abstraction is a shared provider contract and a shared termination / downgrade / trace model.

## Non-Goals For V1

Do not build these in V1:
- one generic auto-close engine for every surface
- provider-owned ASTs
- semantic guessing such as `\\gam -> \\gamma`
- environment repair for LaTeX
- `\\left ... \\right` repair
- broad block HTML auto-close
- ambitious MDX expression repair
- public third-party provider API beyond the existing regex-style surface
- broad seeded-smoke expansion before trace tooling exists

These items are out of the active V1 denominator and belong to post-V1 follow-up only.

## V1 Scope

V1 includes:
- anticipation orchestrator and trace schema
- migration of existing inline-format behavior onto the new contract
- regex anticipation adapter onto the same contract
- normalized container context and invalidation
- HTML inline allowlist provider
- conservative HTML block fallback policy
- MDX tag allowlist provider
- MDX expression off by default or brace-only trivial experimental mode
- math inline/block bounded repair subset
- adversarial fixture set and trace-driven debugging workflow

## V1 Status

Lookahead V1 is complete for its bounded scope.

Completed phases:
- Phase 0: contract + trace skeleton
- Phase 1: migrate existing inline + regex behavior
- Phase 2: container context + invalidation
- Phase 3: HTML / MDX providers
- Phase 4: Math V1 bounded repair
- Phase 5: adversarial hardening
- Phase 6: selective smoke promotion

What remains after V1 is explicitly post-V1 work and is no longer part of the active completion denominator.

## Reduced V1 Contract

This is the reduced contract we should actually implement first.
It is intentionally smaller than the planner draft.

### Surfaces

```ts
export type LookaheadSurface =
  | "inline-format"
  | "regex"
  | "math-inline"
  | "math-block"
  | "html-inline"
  | "html-block"
  | "mdx-tag"
  | "mdx-expression";
```

### Safety classes

```ts
export type LookaheadSafety = "safe" | "guarded" | "unsafe";
```

Rules:
- `safe`: mechanical closure or bounded tail trim only
- `guarded`: local structural repair requiring validation before render
- `unsafe`: semantic guessing or unbounded capture; never rendered in production

### Decisions

```ts
export type LookaheadDecision =
  | "accept-as-is"
  | "repair"
  | "safe-prefix"
  | "surface-fallback"
  | "raw"
  | "terminate";
```

### Termination reasons

```ts
export type LookaheadTerminationReason =
  | "budget-chars"
  | "budget-newlines"
  | "budget-nesting"
  | "budget-steps"
  | "validation-failed"
  | "no-progress"
  | "unsupported-syntax"
  | "container-instability"
  | "protected-range-conflict"
  | "unsafe-repair-required"
  | "surface-mismatch";
```

### Downgrade modes

```ts
export type LookaheadDowngradeMode =
  | "raw"
  | "safe-prefix"
  | "surface-fallback";
```

### Repair ops

```ts
export type LookaheadRepairOp =
  | { kind: "append"; text: string }
  | { kind: "trim-tail"; count: number }
  | { kind: "insert-empty-group" }
  | { kind: "close-tag"; tagName: string }
  | { kind: "self-close-tag" }
  | { kind: "close-delimiter"; text: string };
```

### Container context

```ts
export interface LookaheadContainerContext {
  blockType: string;
  ancestorTypes: readonly string[];
  listDepth: number;
  blockquoteDepth: number;
  insideHtml: boolean;
  insideMdx: boolean;
  segmentOrigin: "direct-inline" | "mixed-content";
  mixedSegmentKind?: "text" | "html" | "mdx";
  provisional: boolean;
  containerSignature: string;
}
```

This is the minimum context that should be implemented in V1. Do not pass AST objects or sibling references into providers.

### Budgets

```ts
export interface LookaheadBudgets {
  maxScanChars: number;
  maxNewlines: number;
  maxSyntheticOps: number;
  maxNestingDepth: number;
  maxValidationFailures: number;
  maxProviderMs: number;
}
```

### Request / plan

```ts
export interface LookaheadRequest {
  surface: LookaheadSurface;
  raw: string;
  absoluteRange: { start: number; end: number };
  context: LookaheadContainerContext;
  budgets: LookaheadBudgets;
  previousAttempt?: {
    decision: LookaheadDecision;
    terminationReason?: LookaheadTerminationReason;
    validationFailures: number;
  };
}

export interface LookaheadPlan {
  providerId: string;
  decision: LookaheadDecision;
  safety: LookaheadSafety;
  ops: readonly LookaheadRepairOp[];
  parseMode: { kind: "full" } | { kind: "safe-prefix"; length: number };
  downgrade?: {
    mode: LookaheadDowngradeMode;
    reason: string;
  };
  termination?: {
    reason: LookaheadTerminationReason;
    rearmWhen:
      | "next-byte"
      | "new-delimiter"
      | "newline-change"
      | "container-change"
      | "finalization";
  };
  debug?: {
    strategy: string;
    notes?: string[];
  };
}
```

### Provider interface

```ts
export interface LookaheadProvider {
  id: string;
  surface: LookaheadSurface;
  priority: number;
  maxSafety: LookaheadSafety;
  supports(req: LookaheadRequest): boolean;
  plan(req: LookaheadRequest): LookaheadPlan;
}
```

## Hard Invariants

1. Providers operate only on their assigned local range.
2. Providers may only add tail-local closure or placeholders; they may not invent semantic payload.
3. Providers may not cross protected ranges for math, HTML, or MDX.
4. Guarded plans must pass locality validation before render.
5. A terminated plan latches until a real rearm condition occurs.
6. Container signature changes invalidate descendant anticipation state.
7. Finalized output must converge to the non-anticipated parse for the final source.

## Exact Module Plan

### Primary core modules
- `packages/markdown-v2-core/src/streaming/inline-streaming.ts`
- `packages/markdown-v2-core/src/inline-parser.ts`
- `packages/markdown-v2-core/src/mixed-content.ts`
- `packages/markdown-v2-core/src/types.ts`

### Primary worker modules
- `packages/markdown-v2-worker/src/worker.ts`
- `packages/markdown-v2-worker/src/inline-streaming.ts`
- `packages/markdown-v2-worker/src/streaming/incremental-matcher.ts`
- `packages/markdown-v2-worker/src/streaming/lezer-streaming.ts`

### Primary plugin modules
- `packages/markdown-v2-plugins/src/plugins/math/index.ts`
- `packages/markdown-v2-plugins/src/plugins/math/streaming-v2.ts`
- `packages/markdown-v2-plugins/src/plugins/math/tokenizer.ts`
- `packages/markdown-v2-plugins/src/plugins/html/index.ts`
- `packages/markdown-v2-plugins/src/plugins/mdx/index.ts`

### React / renderer touchpoints
- `packages/markdown-v2-react/src/streaming-markdown.tsx`
- `packages/markdown-v2-react/src/contexts/math-tracker.ts`
- `packages/markdown-v2-react/src/mdx-coordinator.ts`
- `packages/markdown-v2-react/src/utils/inline-html.ts`

### Tooling / harness touchpoints
- `scripts/analyze-test-snippets.ts`
- `scripts/regression/run-html-snapshots.ts`
- `scripts/regression/run-seeded-smoke.ts`
- `apps/docs/app/regression/snippet-test/page.tsx`
- `apps/docs/app/regression/html/page.tsx`
- `apps/docs/components/regression/html-harness.tsx`

### Existing tests to preserve and/or migrate
- `packages/markdown-v2-core/__tests__/inline-streaming-anticipation.test.ts`
- `packages/markdown-v2-core/__tests__/regex-anticipation.test.ts`
- `packages/markdown-v2-core/__tests__/mixed-content-unclosed-html.test.ts`
- `packages/markdown-v2-worker/__tests__/format-anticipation-streaming.test.ts`
- `packages/markdown-v2-worker/__tests__/list-item-format-anticipation.test.ts`
- `packages/markdown-v2-worker/__tests__/mdx-segment-boundary-streaming.test.ts`
- `packages/markdown-v2-react/__tests__/streaming-list-anticipation.test.tsx`

## Phase Plan

## Phase 0. Contract + trace skeleton

Goal:
- define the narrow waist without changing visible behavior

Tasks:
- add repo-local contract doc: `docs/LOOKAHEAD_CONTRACT.md`
- add minimal internal types for:
  - surface
  - safety
  - decision
  - termination reason
  - downgrade mode
  - repair op
  - container context
- add orchestrator shell and provider registry in core/worker code
- run existing anticipation in shadow mode through the orchestrator
- add trace schema and artifact layout
- extend `scripts/analyze-test-snippets.ts` with a lookahead trace mode

Definition of done:
- no visible behavior change
- shadow trace bundle emits for existing anticipation fixtures
- traces include provider selection, plan, termination, and downgrade metadata

Current status:
- `docs/LOOKAHEAD_CONTRACT.md` is in place
- internal contract types exist in `packages/markdown-v2-core/src/streaming/lookahead-contract.ts`
- trace mode exists in `scripts/analyze-test-snippets.ts`
- exported-site trace workflow is now the canonical path; see `docs/LOOKAHEAD_TRACE_WORKFLOW.md`
- provider selection, decision, safety, repair ops, container signature, invalidation hints, termination, and downgrade data now appear in artifacts for the current inline/regex path
- first stable trace bundles exist for:
  - `anticipation-inline.md`
  - `nested-formatting-ancestors.md`
  - `inline-html-allowlist.md`

## Phase 1. Migrate existing inline + regex behavior

Goal:
- move current behavior under the contract before adding new surface logic

Tasks:
- implement `inline-format` provider using current delimiter closure behavior
- adapt regex anticipation onto provider model, preserving existing public config
- route safe-prefix fallback through the same decision model
- add termination and rearm metadata to existing inline behavior
- remove policy from ad hoc inline branches where possible

Definition of done:
- current inline tests still pass
- `inline-format` and `regex` traces are emitted through the orchestrator
- no visible regression on current `anticipation-inline` fixture family

Current status:
- the core prepare path in `packages/markdown-v2-core/src/streaming/inline-streaming.ts` now emits contract-shaped decisions for `inline-format` and `regex`
- worker-side regex anticipation has been routed through the same prepare path instead of a worker-only append branch
- current inline and regex tests are green
- regression coverage for nested and inline HTML fixtures is green on the exported server workflow

## Phase 2. Container context + invalidation

Goal:
- make anticipation container-aware and stable under reparses

Tasks:
- define `containerSignature` computation
- plumb normalized container context into anticipation request paths
- invalidate descendant anticipation state when container signature changes
- unify top-level and nested inline anticipation paths
- add explicit sibling-isolation checks

Definition of done:
- nested list and blockquote text runs through the same anticipation machinery as top-level paragraph text
- parent reparses do not leave stale child anticipation behind
- targeted nested tests prove no sibling swallowing or ghost anticipation

Current status:
- minimal container signatures are now computed and attached to current inline anticipation results
- worker metadata now emits:
  - `inlineContainerSignature`
  - `inlineLookaheadInvalidated`
- list and blockquote inline preparation now uses the same core prepare path with normalized context
- targeted nested tests and nested regression fixtures are in place and passing
- normalized container signatures now cover paragraph, heading, blockquote, list, and nested list inline preparation paths
- invalidation metadata is emitted when local text fields or container signatures change
- sibling-isolation and nested-context tests are in place and green
- this phase is effectively complete for the current inline, regex, HTML-inline, and MDX-tag surfaces

## Phase 3. HTML / MDX providers

Goal:
- move bounded tag anticipation out of segmentation policy and into providers

Implemented:
- reduce mixed-content layer to localization/classification only
- implement `html-inline` allowlist provider
- keep `html-block` conservative: default to fallback/raw on ambiguity
- implement `mdx-tag` allowlist provider
- keep `mdx-expression` as explicit hard-stop / fallback for V1
- add explicit no-swallow validation for HTML/MDX providers

Definition of done:
- HTML/MDX anticipation decisions show up in traces as provider decisions, not hidden segmentation behavior
- adversarial no-swallow fixtures pass
- no block-level open tag/component can consume unrelated following content

Closure status:
- mixed-content extraction now localizes/classifies and surfaces provider decisions instead of owning repair policy directly
- `html-inline` allowlist provider behavior is live for bounded local inline tags
- `mdx-tag` allowlist provider behavior is live for bounded local inline component tags
- `mdx-expression` now exists as an explicit hard-stop / fallback provider surface with trace visibility
- browser/regression coverage is green for:
  - `block-html-no-swallow.md`
  - `mdx-tag-allowlist-inline.mdx`
  - `mdx-tag-no-swallow-negative.mdx`
- `mdx-expression-no-swallow-negative.mdx` is green in browser regression HTML coverage
- `mdx-tag-allowlist-inline.mdx` covers the bounded inline paragraph/list/blockquote preview contract
- `mdx-expression` is intentionally finished as hard-stop / fallback behavior for V1, not a pending repair surface

## Phase 4. Math V1 bounded repair

Goal:
- achieve materially better incremental math without semantic guessing

Allowed repair subset:
- trim incomplete trailing control-word fragment
- close tail-local unmatched `{`, `[`, `(`
- close dangling `^` / `_` with empty groups
- insert empty groups for allowlisted constructs:
  - `\\frac`
  - `\\sqrt`
- handle basic partially complete `\\frac{...` and `\\sqrt{...`

Post-V1 only:
- `\\left ... \\right`
- environments such as `\\begin{align}`
- optional argument repair
- macro-name inference
- deeper semantic healing

Implemented:
- add math tail scanner
- add candidate classification:
  - valid incomplete prefix
  - invalid but safely repairable
  - invalid and too speculative
- validate repaired candidates before render
- downgrade unsupported/failed cases to surface fallback or raw rather than flashing KaTeX errors
- add trace data for repairs and validation outcomes

Definition of done:
- supported math cases stream incrementally without red KaTeX error UI
- unsupported cases terminate and downgrade cleanly
- final parse converges with non-stream parse

Closure status:
- a math tail scanner/classifier is now live in the core prepare path
- the bounded V1 subset is implemented for:
  - trailing control-word trim
  - dangling `^` / `_` repair
  - `\\frac` empty-group repair
  - `\\sqrt` empty-group repair
  - tail-local unmatched group closure
- repaired math candidates are validated before render and emit validation results into trace metadata
- unsupported math cases explicitly hard-stop and fall back for:
  - `\\left`
  - `\\right`
  - `\\begin{...}`
  - optional-argument ambiguity
- unit coverage is green for the bounded subset and hard-stop behavior
- `nested-math-inline.md` remains green in browser regression HTML coverage
- `math-inline-supported.md` is now green in browser regression HTML coverage and seed-stable
- `math-inline-hard-stop-negative.md` is now green in browser regression HTML coverage for unsupported inline cases
- `math-display-supported.md` is now part of the reduced browser/regression surface for bounded display math
- `math-display-hard-stop-negative.md` is now part of the targeted browser/regression surface for conservative unsupported display math
- display math follows the same bounded subset as inline math only when repairs remain tail-local and validate cleanly
- `math-hard-stop-negative.md` remains targeted trace/unit coverage for the broader unsupported family and is intentionally not smoke-promoted

## Phase 5. Adversarial hardening

Goal:
- tighten the plan under debugger-style observation before smoke promotion

Implemented:
- add chunk-mode traces for representative fixtures
- add char-mode traces for a small adversarial subset
- add browser checks for:
  - no red KaTeX flashes on supported cases
  - no swallowed HTML/MDX neighbors
  - no nested sibling corruption
- capture first-divergence artifacts on failures

Definition of done:
- failure artifacts are actually useful for triage
- first bad step is easy to locate
- traces explain provider, plan, downgrade, and termination decisions

## Phase 6. Selective smoke promotion

Goal:
- maintain only reduced, stable cases in seeded smoke after trace-driven hardening

Targeted-only by design in V1:
- MDX tag hard-stop negatives
- MDX expression negatives
- regex bound / DOS negatives
- kitchen-sink integration fixture

Definition of done:
- smoke remains stable
- failures always have useful artifacts
- no broad smoke expansion without evidence

Current status:
- reduced stable cases now promoted into seeded smoke:
  - `nested-formatting-ancestors`
  - `inline-html-allowlist`
  - `block-html-no-swallow`
  - `math-inline-supported`
  - `math-display-supported`
  - `mdx-tag-allowlist-inline`
- non-smoke items remain targeted-only:
  - `mdx-tag-no-swallow-negative`
  - `mdx-expression-no-swallow-negative`
  - `math-inline-hard-stop-negative`
  - `math-display-hard-stop-negative`
  - `math-hard-stop-negative`

Final promotion criteria for this reduced smoke set:
- stable regression HTML output across seeded replay
- stable char/chunk traces for the surface family
- no known flaky termination / downgrade behavior
- useful failure artifacts when parity breaks

## Reduced Fixture Set

These are the canonical reduced V1 fixtures.

### 1. `nested-formatting-ancestors.md`
Provokes:
- paragraph vs list item vs nested list item vs blockquote
- same incomplete inline formatting behavior across container types

### 2. `nested-math-inline.md`
Provokes:
- inline math inside paragraph, list items, nested list items, and blockquotes
- splits inside `\\frac`, `\\sqrt`, `^`, `_`, `{`, `}`

### 3. `inline-html-allowlist.md`
Provokes:
- benign inline HTML auto-close in bounded local segments
- split in tag name, attrs, quote values

### 4. `block-html-no-swallow.md`
Provokes:
- unclosed block tag followed by unrelated blocks
- must downgrade, never swallow

### 5. `mdx-tag-allowlist-inline.mdx`
Provokes:
- allowlisted MDX tag closure in bounded local inline cases

### 6. `math-hard-stop-negative.md`
Provokes:
- unsupported math constructs that must terminate cleanly
- `\\left`
- `\\begin{align}`
- optional argument ambiguity

Current status:
- implemented as a targeted trace/unit fixture
- intentionally not promoted into browser regression HTML coverage yet

### 7. `math-inline-supported.md`
Provokes:
- supported inline math subset
- no-error rendering under list and blockquote ancestors

### 8. `math-inline-hard-stop-negative.md`
Provokes:
- unsupported inline math hard-stop / fallback
- preserved trailing prose and sibling content

### 9. `mdx-expression-no-swallow-negative.mdx`
Provokes:
- explicit `mdx-expression` hard-stop / fallback
- preserved trailing prose in paragraph, list, and blockquote contexts

### 10. `math-display-supported.md`
Provokes:
- bounded display-math repair under the supported V1 subset
- no-error rendering with list and blockquote neighbors

### 11. `math-display-hard-stop-negative.md`
Provokes:
- unsupported display-math hard-stop / fallback
- preserved trailing prose and following list content

### 12. `kitchen-sink-lookahead.mdx`
Provokes:
- integrated stress case
- permanently targeted-only for V1

## Trace Artifact Layout

Trace output should be small on stdout and rich on disk.

Recommended artifacts:
- `trace-summary.json`
- `trace.ndjson`
- `steps/step-XXXX.json`
- `html/step-XXXX.html`
- `diffs/step-XXXX.json`
- `provider-stats.json`
- `failures/first-divergence.json`

Current implementation note:
- the current trace workflow emits:
  - `trace-summary.json`
  - `trace.ndjson`
  - `steps/step-XXXX.json`
  - `steps/telemetry-XXXX.json`
  - `diffs/step-XXXX.json`
- the artifact shape is already useful for Phase 0 and Phase 1 work even though the full aspirational layout is not populated yet
- HTML / MDX mixed lookahead decisions now appear in step artifacts under `mixedLookahead`

Console output should only surface:
- first provider switch
- first termination
- first downgrade
- first divergence
- artifact path
- canonical trace replay command

## Initial File Deliverables

These were the original tranche deliverables:
- `docs/LOOKAHEAD_CONTRACT.md`
- `docs/LOOKAHEAD_V1_EXECUTION_PLAN.md`
- lookahead trace mode in `scripts/analyze-test-snippets.ts`
- first fixture trio:
  - `nested-formatting-ancestors.md`
  - `nested-math-inline.md`
  - `inline-html-allowlist.md`

## Acceptance Criteria For The First Tranche

These tranche criteria are now satisfied:
- existing inline anticipation is running through the new orchestrator in shadow or active mode
- provider decisions and termination reasons are visible in artifacts
- nested container anticipation is using normalized container context
- no new visible regressions on existing anticipation fixtures
- the first adversarial traces are readable and useful

Additional tranche rule:
- do not count fixture creation or trace emission alone as progress
- a new fixture only counts when it also has assertions, regression coverage, or stable trace expectations

## Resolved Design Decisions

The early design questions are now closed for V1:
- mixed-content localizes/classifies and does not own repair policy
- `containerSignature` is generated in the current inline preparation path and propagated through worker metadata
- `safe-prefix` remains available in the contract but is not the mainline path for the shipped V1 surfaces
- math validation lives in the shared orchestrator/core repair path before render
- provider state is treated as local to the current range and invalidated by container-signature and local-field changes

## Historical Sequencing

The tranche was executed in this order:
1. contract
2. trace harness
3. migrate existing inline + regex behavior
4. container context and invalidation
5. HTML / MDX providers
6. math V1 bounded repair
7. adversarial hardening
8. selective smoke promotion

That sequencing produced the shipped V1 subsystem and remains the recommended order for any future rework of similar scope.

## V1 closure notes

MDX V1:
- bounded inline `mdx-tag` repair is complete for the allowlisted local subset
- `mdx-expression` is intentionally hard-stop / fallback only
- broader expression healing is explicitly post-V1 only

Math V1:
- inline and display math both use the same bounded repair subset when repair stays local and validation passes
- unsupported families hard-stop / fallback instead of guessing
- smoke-eligible math cases are limited to reduced deterministic supported fixtures

## Post-V1 Roadmap Boundary

The following work is explicitly outside completed V1 scope:
- richer `mdx-expression` healing beyond hard-stop / fallback
- LaTeX environments
- `\\left ... \\right`
- optional-argument repair
- broad block HTML anticipation
- public provider / plugin ABI
- kitchen-sink smoke promotion
- performance optimization of the settled lookahead subsystem
