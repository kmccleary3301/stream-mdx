# Lookahead Post-V1 Roadmap

This document contains work that is explicitly outside completed Lookahead V1 scope.

These items do **not** count against the active V1 completion denominator.

## Post-V1 candidates

- richer `mdx-expression` healing beyond hard-stop / fallback
- LaTeX environments
- `\left ... \right` repair
- optional-argument repair
- broad block HTML anticipation
- public provider / plugin ABI
- kitchen-sink smoke promotion
- optimization work on the settled lookahead subsystem

## Why these are out of scope

Lookahead V1 is intentionally bounded:
- repairs are local
- validation is explicit
- unsupported families degrade conservatively
- smoke only covers reduced deterministic supported cases

The items above either:
- require broader semantic inference,
- would materially expand the support contract,
- or belong to performance/productization work after the behavior contract is already closed.
