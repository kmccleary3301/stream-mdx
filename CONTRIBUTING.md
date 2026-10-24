# Contributing

Thanks for helping improve StreamMDX.

## Development setup

Requirements:

- Node.js 20+
- npm 9+ (npm workspaces)

Clone and install:

```bash
npm install
```

Build everything:

```bash
npm run build
```

Run tests:

```bash
npm test
```

Each package runs its test files in separate processes, up to `min(4, cores - 1)` at once. Set `STREAM_MDX_TEST_CONCURRENCY=1` for serial runs.

Mutation-test a pure owner after building packages (targets live in `scripts/mutation/targets.mjs`; reports go to `tmp/mutation/<target>.json`):

```bash
npm run mutation -- core-table-state                 # every mutant in the target's files
npm run mutation -- core-table-state --since=main    # only lines changed since main
```

Every test file of every mutant runs in its own prewarmed process, and results are never reused between runs. Cross-package consumer tests reach the mutated source through the target's `redirects`.

Build the hosted worker for the example app:

```bash
npm run worker:build
```

Run the “pack + install” smoke test (builds packed tarballs, installs them into a scratch Next app, and runs `next build`):

```bash
npm run ci:pack-smoke
```

## Repo layout

- `packages/` contains the published packages (`@stream-mdx/*` and `stream-mdx`)
- `examples/streaming-markdown-starter` is the minimal Next.js sandbox for manual QA
- `docs/` contains the user-facing documentation

## Making changes

- Keep PRs small and focused.
- Prefer updating docs when changing behavior or public API.
- If you add a new public entrypoint, update package `exports` and add a smoke test where feasible.

## Changesets (releases)

This repo uses Changesets to manage versions and changelogs.

- Add a changeset for user-facing changes:

```bash
npm run changeset
```

- Versioning and publishing are handled by GitHub Actions once Trusted Publishing is configured.

See:

- `.github/workflows/release.yml`
- `docs/STREAMING_MARKDOWN_RELEASE_CHECKLIST.md`

## Code of Conduct

By participating, you agree to `CODE_OF_CONDUCT.md`.

