# Lookahead V1 Closeout

Lookahead V1 is complete for its bounded scope.

## What V1 guarantees

- contract-shaped provider orchestration for the shipped surfaces
- normalized container context and invalidation
- bounded `html-inline` anticipation
- bounded `mdx-tag` anticipation
- explicit `mdx-expression` hard-stop / fallback
- bounded inline and display math repair for the supported subset
- explicit downgrade / termination / trace metadata
- reduced seeded smoke for deterministic supported cases

## What V1 does not attempt

- broad MDX expression healing
- LaTeX environments
- `\left ... \right`
- optional-argument repair
- broad block HTML anticipation
- public provider ABI
- kitchen-sink smoke promotion

Those items are tracked in [`LOOKAHEAD_POST_V1_ROADMAP.md`](./LOOKAHEAD_POST_V1_ROADMAP.md).

## Final verification state

The final V1 closure state is expected to satisfy:
- targeted provider/unit tests green
- reduced browser/regression suite green
- reduced seeded smoke green
- docs build and docs link checks green
- trace workflow aligned with the final support matrix

## Operational note

For future debugging, start with [`LOOKAHEAD_TRACE_WORKFLOW.md`](./LOOKAHEAD_TRACE_WORKFLOW.md).
