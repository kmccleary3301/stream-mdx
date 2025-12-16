# Tests — `@stream-mdx/react`

Renderer/store/scheduler tests are migrating out of `lib/markdown-v2/tests/` into this package. The most critical suites now live here.

## Current coverage

- ✅ `patch-commit-scheduler.test.ts`
- ✅ `patch-coalescing.test.ts`
- ✅ `list-depth-normalization.test.ts`
- ✅ `inline-html-rendering.test.ts`
- ✅ `store-reorder.test.ts`
- ✅ `virtualized-list-config.test.ts`
- ✅ `patch-batching.test.ts`

## TODO

- [ ] Update integration docs/tests that still point to `lib/markdown-v2/tests/` to reference these new files.
- [ ] Split remaining heavy integration suites (e.g., streaming invariants) into smaller unit tests aligned with the new modules.
