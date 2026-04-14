# Lookahead V2 Execution Plan

Repo anchor:
- repo: `stream-mdx`
- branch: `main`
- source planner response: `docs_tmp/LOOKAHEAD/LOOKAHEAD_V2_PLANNER_RESPONSE.md`
- V1 closeout anchor: [`LOOKAHEAD_V1_CLOSEOUT.md`](./LOOKAHEAD_V1_CLOSEOUT.md)

This document is the repo-local execution plan for the first post-V1 lookahead tranche.
It is intentionally narrower than the V2 planner response.

The planner response is directionally right, but this plan only commits to the next **buildable** tranche: **Math V2A**.

## North Star

Keep the closed V1 contract intact while replacing the shallow math repair path with a structured, traceable, family-aware MathTailEngine.

The key outcome is not "support richer TeX broadly." The key outcome is:
- one authoritative math-tail analysis model for anticipation
- richer trace/debug artifacts
- one narrow new supported family beyond V1
- better display-local math behavior without pretending environments are supported

## What This Plan Is Trying To Fix

Lookahead V1 solved the contract problem.
The main remaining weakness is that the math surface is still too shallow internally:
- repair is still mostly local string surgery plus validation
- obligations are implicit rather than modeled
- candidate selection is too flat
- display math is bounded but not yet structured enough
- traces are good, but not math-rich enough to explain harder future work

The problem is no longer the orchestrator.
The problem is the math provider internals and the trace/registry surfaces around them.

## Non-Goals For Math V2A

Do not build these in Math V2A:
- LaTeX environments such as `\begin{align}` or `\begin{matrix}`
- alignment-like structures (`&`, row/cell inference, `\\` semantics)
- generic optional-argument repair
- broad `mdx-expression` healing
- block HTML anticipation expansion
- public provider / plugin ABI
- kitchen-sink smoke promotion
- optimization-first work

These remain outside the active Math V2A denominator.

## Scope Of Math V2A

Math V2A includes:
- executable feature registry groundwork for richer math families
- math-specific trace schema extension
- MathTailEngine shadow mode
- migration of current V1 math families onto the MathTailEngine
- checkpointed candidate selection
- one new supported family:
  - `left-right-local` null-delimiter completion (`\right.` / `\left.` under strict rules)
- display-local multiline checkpointing for non-environmental display math
- targeted hard-stop family classification for:
  - environments
  - alignment-like structures
  - unsupported optional-argument families
- replay/fixture/trace hardening for the new math path

## Active Decision Gates

These are explicit yes/no gates, not hidden future scope inside Math V2A.

### Gate 1: Optional-argument pilot
After Math V2A stabilizes, decide whether a narrow `\sqrt[...]` subset is worth a targeted pilot.

Current default:
- deferred
- no implementation work in the first live tranche

### Gate 2: MDX expression future subset
After Math V2A stabilizes, decide whether `mdx-expression` remains permanently hard-stop / fallback or whether a tiny property-path-only subset deserves a later pilot.

Current default:
- no behavior change in Math V2A
- keep `mdx-expression` conservative

## Math V2A Thesis

Math V2A keeps the V1 provider/orchestrator narrow waist but replaces the math surface internals with:

- structured tail tokenization
- family classification
- obligation tracking
- checkpoint tracking
- staged candidate generation
- validator-backed candidate selection
- math-specific trace artifacts

The model is:

`tail analysis -> obligations -> candidate staging -> validation -> selection -> downgrade / termination / rearm`

That is intentionally not:
- a full TeX parser
- renderer-driven repair
- semantic macro inference
- environment completion

## Internal Math Family Taxonomy

Math V2A should classify math into internal families even when external provider surfaces remain `math-inline` and `math-block`.

| Family | Meaning | V2A status |
| --- | --- | --- |
| `local-core` | local braces/parens/brackets, control words, scripts, simple local expressions | supported |
| `fixed-arity-local` | allowlisted fixed-arity commands such as `\frac` and `\sqrt` without optional-arg repair | supported |
| `left-right-local` | one unmatched local `\left` / `\right` family | supported in narrow null-delimiter subset |
| `display-local` | multiline display math with no environment/alignment structure | supported |
| `optional-arg-local` | allowlisted optional-arg family such as `\sqrt[n]{...}` | classified only, deferred as a gate |
| `environment-structured` | `\begin{...}` / `\end{...}` families | classify and hard-stop |
| `alignment-structured` | top-level `&`, row/cell structure, align-like families | classify and hard-stop |
| `unknown` | anything outside the bounded local families | classify and hard-stop |

## Math V2A Boundaries

### Supported in Math V2A
- current V1 bounded repairs:
  - trailing control-word trim
  - tail-local unmatched group closure
  - dangling `^` / `_` repair
  - allowlisted missing-group repair for `\frac` and `\sqrt`
- checkpointed candidate selection
- display-local multiline checkpointing
- `left-right-local` null-delimiter completion only:
  - `\left(` may close with `\right.`
  - a dangling `\right` may close with `.`
  - no guessed delimiter symmetry
  - no nested left/right support

### Explicitly unsupported in Math V2A
- matrix-like environments
- alignment-like environments
- generic environment completion
- guessed macro names
- guessed right delimiters
- generic optional arguments
- nested left/right structures
- interior repair that is not tail-local

## Hard Invariants

Math V2A keeps the V1 invariants and adds these math-specific ones:

1. The math provider may operate only inside an already-identified math-local range.
2. Repairs may only add tail-local structure or choose a bounded validated checkpoint.
3. Repairs may not consume following Markdown, HTML, or MDX bytes.
4. Repaired candidates may not cross protected ranges.
5. Display math may not expand ownership indefinitely.
6. Checkpoint selection may not hide substantial already-typed semantic tail content.
7. Unsupported families must degrade; they may not mutate into other families.
8. Validation success alone is not enough if the candidate violates the honesty rules.

## Planned Internal Data Shape

This is the conceptual shape we should implement first. It is a guide, not a frozen ABI.

### Tail analysis
- mode: `inline` or `display`
- family classification
- token sequence
- obligation list
- unsupported-family classification when relevant
- checkpoint table

### Candidate staging
Ordered candidate set only:
1. full-tail repaired candidate
2. family-specific candidate
3. checkpoint candidate
4. raw fallback

Candidate search must stay tiny and ordered. No combinatorial search.

### Validation classes
- `already-valid`
- `repair-valid`
- `checkpoint-valid`
- `unsupported-family`
- `candidate-invalid`
- `candidate-unsafe`

## Exact Module Plan

### Primary code targets
- `packages/markdown-v2-core/src/streaming/lookahead-contract.ts`
- `packages/markdown-v2-core/src/streaming/inline-streaming.ts`
- `packages/markdown-v2-core/src/mixed-content.ts`
- `packages/markdown-v2-core/src/block-snapshot.ts`
- `packages/markdown-v2-worker/src/worker.ts`
- `packages/markdown-v2-plugins/src/plugins/math/streaming-v2.ts`
- `packages/markdown-v2-plugins/src/plugins/math/tokenizer.ts`

### Primary tests and harness targets
- `packages/markdown-v2-core/__tests__/lookahead-support-matrix.test.ts`
- `packages/markdown-v2-core/__tests__/lookahead-trace-contract.test.ts`
- `packages/markdown-v2-core/__tests__/lookahead-orchestrator.test.ts`
- `packages/markdown-v2-core/__tests__/inline-streaming-anticipation.test.ts`
- `packages/markdown-v2-worker/__tests__/mixed-lookahead-provider.test.ts`
- `scripts/analyze-test-snippets.ts`
- `scripts/regression/run-html-snapshots.ts`
- `scripts/regression/run-seeded-smoke.ts`

### Docs and support-surface targets
- `docs/LOOKAHEAD_CONTRACT.md`
- `docs/LOOKAHEAD_TRACE_WORKFLOW.md`
- `docs/LOOKAHEAD_POST_V1_ROADMAP.md`
- `docs/README.md`

## Phase Plan

## Phase 0. Registry and trace groundwork

Goal:
- prepare the system for richer math without changing visible behavior

Build:
- executable feature registry for richer math families
- richer trace-schema slots for provider-specific math analysis
- first-divergence categorization improvements
- focused trace controls
- artifact tiering

Entry criteria:
- V1 closed and stable
- current reduced smoke green

Exit criteria:
- existing V1 traces still work
- math-specific schema fields can be emitted in shadow mode
- docs/tests can read the richer registry data

Definition of done:
- zero visible behavior changes
- trace artifacts richer and easier to target

## Phase 1. MathTailEngine shadow mode

Goal:
- introduce structured math-tail analysis without changing production decisions yet

Build:
- tokenization
- obligation analysis
- family classification
- checkpoint tracking
- candidate staging
- dual-run comparison against current V1 math behavior

Entry criteria:
- Phase 0 complete

Exit criteria:
- shadow traces show family and obligations
- current math outputs remain unchanged
- the team can explain a failing math case using traces alone

Definition of done:
- the MathTailEngine exists in shadow mode and is usable for debugging

## Phase 2. Math V2A live path

Goal:
- switch live math anticipation to the MathTailEngine for the currently supported V1 families plus one new family

Build:
- current V1 math families through the new engine
- checkpointed candidate selection
- `left-right-local` null-delimiter subset
- display-local multiline checkpointing
- richer downgrade, termination, and rearm metadata

Entry criteria:
- shadow mode stable
- no unexplained family-classification drift

Exit criteria:
- V1 math fixtures still pass
- new left/right fixtures pass
- unsupported env/alignment families classify and degrade cleanly
- traces are understandable without source spelunking

Definition of done:
- Math V2A is live
- one new supported family is documented
- support matrix updated
- current smoke preserved except justified additions

## Phase 3. Optional-argument decision gate

Goal:
- make a hard yes/no decision on whether a narrow `\sqrt[...]` subset deserves a later targeted pilot

Build:
- no live behavior required in the mainline tranche
- only classification, evidence gathering, and targeted fixtures if the product case is real

Entry criteria:
- Math V2A stable
- replay or fixture evidence shows real `\sqrt[n]{...}` pain

Exit criteria:
- either explicitly deferred
- or approved for a later targeted pilot with a support-matrix entry

Definition of done:
- explicit decision, not hidden future scope

## Phase 4. MDX decision gate

Goal:
- decide whether any future `mdx-expression` subset is worth pursuing after Math V2A

Build:
- no runtime change required
- if needed, write down the future tiny subset candidate and the reasons it remains deferred

Entry criteria:
- Math V2A stable
- traces and registry mature

Exit criteria:
- either `mdx-expression` remains hard-stop / fallback
- or a tiny property-path subset is approved for a later targeted pilot

Definition of done:
- hard scope decision, not an open-ended maybe

## Phase 5. Selective smoke promotion and hardening

Goal:
- promote only what deserves promotion and harden the new math families before any broader claims

Build:
- targeted fixture growth
- fuzz or randomized boundary slicing for math
- replay corpus growth for harder math families
- trace bundle minimization and failure-artifact polish
- smoke promotions only after probation

Entry criteria:
- Math V2A live and stable
- support claims frozen

Exit criteria:
- smoke remains conservative
- failure artifacts are useful
- no support-matrix drift

Definition of done:
- release discipline improved, not loosened

## First Fixture Set

These should be the first new Math V2A fixtures.

### 1. `math-left-right-null-right-supported.md`
Provokes:
- unmatched `\left(`
- null-right repair with `\right.`
- final convergence when the true `\right)` arrives
- no guessed delimiter symmetry

### 2. `math-left-right-nested-negative.md`
Provokes:
- nested `\left...\right`
- explicit unsupported-family classification
- clean downgrade / termination

### 3. `math-display-local-multiline.md`
Provokes:
- multiline display math
- no environment markers
- checkpoint improvement over raw fallback
- no red-flash regression

### 4. `math-environment-hard-stop-negative.md`
Provokes:
- `\begin{matrix}` and/or `\begin{align}`
- family classification to `environment-structured`
- conservative downgrade

### 5. `math-alignment-hard-stop-negative.md`
Provokes:
- top-level `&`
- top-level row separators
- family classification to `alignment-structured`

### 6. `math-checkpoint-vs-raw.md`
Provokes:
- full-tail candidate invalid
- checkpoint candidate valid
- explicit selected-candidate behavior in traces

## Trace Artifact Additions

Math V2A should add these artifacts or equivalent structured payloads.

### `math-tail-analysis.json`
Contains:
- mode
- family
- token list
- obligation list
- unsupported-family classification
- checkpoint list

### `math-candidates.json`
Contains:
- ordered candidate stages
- candidate kind (`full`, `family`, `checkpoint`, `raw`)
- rendered candidate source

### `math-validation.json`
Contains:
- candidate-by-candidate validation result
- rejection reasons
- selected candidate
- selected fidelity tier

### `latch-rearm.json`
Contains:
- prior termination state
- current latch state
- rearm trigger
- why the provider retried

### `focus-summary.json`
Contains:
- first provider activation
- first repair
- first termination
- first downgrade
- first visible HTML divergence
- first convergence recovery

## Acceptance Criteria

We should not call Math V2A done unless all of these are true:

1. The current V1 math subset runs through the MathTailEngine.
2. `left-right-local` null-delimiter completion is live and documented.
3. Display-local multiline checkpointing is live for non-environmental display math.
4. Unsupported environment and alignment families classify explicitly and degrade cleanly.
5. Trace artifacts explain math behavior in terms of family, obligations, candidates, checkpoints, and latch/rearm state.
6. Supported Math V2A cases do not flash KaTeX error UI in targeted browser regression.
7. Docs, tests, support matrix, and smoke eligibility remain aligned.
8. Reduced smoke is not broadened casually.

## Maintainer Guidance

When Math V2A work begins:
- do Phase 0 before any live behavior change
- do Phase 1 before touching left/right or multiline display behavior
- use char-mode traces for token-boundary cases
- use chunk-mode traces for convergence and display-local cases
- keep MDX behavior unchanged unless a later decision gate explicitly reopens it

## Relationship To Other Docs

- [`LOOKAHEAD_CONTRACT.md`](./LOOKAHEAD_CONTRACT.md) remains the closed V1 contract.
- [`LOOKAHEAD_POST_V1_ROADMAP.md`](./LOOKAHEAD_POST_V1_ROADMAP.md) lists all work that is broader than V1.
- This document is the first narrowed execution plan inside that post-V1 space.
- If Math V2A completes successfully, update the roadmap and decide whether optional args or MDX subset work deserve their own follow-on execution plans.
