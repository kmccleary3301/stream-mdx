# Lookahead Post-V1 Roadmap

This document contains work that is explicitly outside the completed Lookahead V1 and V2 scopes.

These items do **not** count against the active V1 or V2 completion denominators.

## Closed scope anchors

- V1 closeout: [`LOOKAHEAD_V1_CLOSEOUT.md`](./LOOKAHEAD_V1_CLOSEOUT.md)
- V2 closeout: [`LOOKAHEAD_V2_CLOSEOUT.md`](./LOOKAHEAD_V2_CLOSEOUT.md)

## Post-V2 candidates

- live optional-argument repair
- richer `\left ... \right` repair beyond the narrow null-delimiter subset
- LaTeX environments
- alignment-family repair
- richer `mdx-expression` healing beyond hard-stop / fallback
- broader block HTML anticipation
- public provider / plugin ABI
- kitchen-sink smoke promotion
- optimization work on the settled lookahead subsystem

## Why these are out of scope

Lookahead V1 and V2 are intentionally bounded:
- repairs stay local
- validation is explicit
- unsupported families degrade conservatively
- smoke only covers reduced deterministic supported cases
- decision gates close with explicit defer/no-change answers instead of silently widening scope

The items above either:
- require broader semantic inference,
- would materially expand the support contract,
- or belong to performance/productization work after the behavior contract is already closed.

## Reopen criteria

Future work should start with a dedicated execution plan when all of these are true:
- the new behavior has a bounded contract
- no-swallow and downgrade behavior can be explained up front
- trace acceptance can be machine-checked
- smoke-worthiness is argued explicitly instead of assumed
