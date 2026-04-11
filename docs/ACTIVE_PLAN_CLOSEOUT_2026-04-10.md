# Active Plan Closeout (2026-04-10)

This note freezes the active denominator for the current StreamMDX hardening/polish program.

## What is considered complete inside the active plan

- correctness hardening:
  - semantic/enrichment classification
  - post-finalize mutation ledger
  - seeded smoke
  - scheduler parity
  - baseline/update discipline
- docs and product surface:
  - root/package/docs README coherence
  - role-based docs wayfinding
  - TUI guide + minimal example path
  - benchmark methodology and comparison language
- public surfaced routes:
  - home
  - docs
  - demo
  - showcase
  - benchmarks
- surfaced showcase set:
  - feature catalog
  - HTML overrides
  - custom regex plugins
  - MDX components
  - Mermaid diagrams
  - perf harness
  - terminal protocol flow
  - hosted worker deployment

## What is explicitly out of the active denominator

See [`POST_100_ROADMAP.md`](./POST_100_ROADMAP.md).

In particular, the active plan no longer includes:

- a much larger article expansion program
- full visual redesign beyond the current surfaced-route polish
- additional benchmark/report writing that does not change product understanding
- richer reference apps beyond the current docs site and minimal TUI example

## Remaining blocker outside the repo

The one known non-repo blocker is custom-domain cutover quality:

- `stream-mdx.dev` currently resolves at DNS level
- HTTPS handshake did not complete cleanly during verification

That means the code/docs side is ready, but custom-domain deployment is not yet fully closed until Vercel/DNS/TLS are corrected.

## Rule going forward

Do not silently re-expand the current denominator. Any new wishlist work should be added under a new milestone/program rather than reopening this one.
