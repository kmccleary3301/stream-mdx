// Mutation targets: pure owners and reducers with the public-seam tests that should kill their
// mutants. `mutate` and package-relative `tests` are relative to the package; tests starting with
// "packages/" are other packages' consumers. `redirects` maps the specifiers those consumers import
// to sandbox source, so they exercise the mutated code (every core subpath shares one module graph).
const coreSource = { "@stream-mdx/core": "src/index.ts", "@stream-mdx/core/*": "src/*.ts" };

export const targets = {
  "core-table-state": {
    package: "packages/markdown-v2-core",
    mutate: ["src/table-block-state.ts", "src/table-row-index.ts"],
    redirects: coreSource,
    tests: [
      "__tests__/table-block-state.test.ts",
      "__tests__/table-records.test.ts",
      "__tests__/table-owner-replacement.test.ts",
      "packages/markdown-v2-worker/__tests__/native-table-owned-frontier.test.ts",
      "packages/markdown-v2-worker/__tests__/worker-table-boundary-streaming.test.ts",
      "packages/markdown-v2-react/__tests__/store-table-retraction.test.ts",
      "packages/markdown-v2-react/__tests__/custom-table-component-streaming.test.tsx",
      "packages/markdown-v2-react/__tests__/table-virtualization.test.tsx",
    ],
  },
  "core-paragraph-spans": {
    package: "packages/markdown-v2-core",
    mutate: ["src/paragraph-span-index.ts", "src/paragraph-block-state.ts"],
    tests: [
      "__tests__/paragraph-span-index.test.ts",
      "__tests__/paragraph-block-state.test.ts",
      "__tests__/paragraph-records.test.ts",
      "__tests__/paragraph-owner-replacement.test.ts",
    ],
  },
  "core-patch-coalescing": {
    package: "packages/markdown-v2-core",
    mutate: ["src/perf/patch-coalescing.ts"],
    tests: [
      "__tests__/patch-coalescing-control-meta.test.ts",
      "__tests__/patch-coalescing-equivalence.test.ts",
      "__tests__/patch-batching-kind.test.ts",
      "__tests__/patch-batching-partition.test.ts",
    ],
  },
};
