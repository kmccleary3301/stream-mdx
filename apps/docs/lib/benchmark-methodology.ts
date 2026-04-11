import type { StreamingSchedulerOptions } from "@stream-mdx/react";

export type BenchmarkProfile = "parity-gfm" | "streaming-heavy";
export type MethodologyMode = "explore" | "ci-locked";
export type OrderMode = "rotate" | "random" | "fixed";

export const BENCHMARK_CI_PROFILE = {
  chunkChars: 42,
  intervalMs: 32,
  repeatCount: 16,
  scoredRuns: 5,
  orderMode: "rotate" as const,
  profile: "parity-gfm" as const,
  chartLayout: "split" as const,
};

export const BENCHMARK_EXPLORE_DEFAULTS = {
  scoredRuns: 1,
  orderMode: "fixed" as const,
};

export const BENCHMARK_STATIC_CONTENT_CLASSES = [
  {
    id: "prose",
    label: "Prose heavy",
    summary: "Narrative markdown with headings, nested lists, links, and inline emphasis.",
  },
  {
    id: "tables",
    label: "Table heavy",
    summary: "Dense table markup where row/cell integrity and stable layout matter more than raw token count.",
  },
  {
    id: "code",
    label: "Code heavy",
    summary: "Multiple fenced blocks with different languages, where syntax-highlighting cost becomes visible.",
  },
  {
    id: "mixed",
    label: "Mixed rich markdown",
    summary: "A combined fixture with tables, tasks, inline code, links, and surrounding prose.",
  },
  {
    id: "rich",
    label: "Rich feature stress",
    summary: "A capability workload with math, MDX, HTML, tables, code, and footnotes. It is not a parity fixture for every engine.",
  },
] as const;

export const BENCHMARK_RUNTIME_COST_TERMS = [
  {
    name: "Shipped client bundle",
    definition: "The JavaScript transferred to the browser for a page route before optional worker assets are considered.",
  },
  {
    name: "Hosted worker asset",
    definition: "The separately served worker bundle used by StreamMDX in production when parsing is isolated off the main thread.",
  },
  {
    name: "Runtime loaded code",
    definition: "Everything the browser eventually executes during a benchmark session, including lazily loaded chunks and worker code.",
  },
  {
    name: "Peak memory",
    definition: "The highest memory sample observed during a local browser run. It is environment-dependent and should only be compared inside the same session class.",
  },
] as const;

export const BENCHMARK_SCHEDULER_MODES = [
  {
    id: "ci-locked",
    label: "CI locked",
    summary:
      "Claim-grade mode. Keeps chunk cadence, order, workload, and StreamMDX scheduling deterministic enough for reproducible local comparisons.",
  },
  {
    id: "explore",
    label: "Explore",
    summary:
      "Diagnosis mode. Lets you vary chunking, interval, ordering, and workload to find cliffs without treating the results as published baselines.",
  },
] as const;

export const BENCHMARK_WORKLOAD_POLICY = [
  {
    id: "parity",
    label: "Parity workloads",
    definition:
      "Common-markdown fixtures used for direct StreamMDX/Streamdown/react-markdown comparisons under the same browser session, scheduler mode, and scenario.",
  },
  {
    id: "capability",
    label: "Capability workloads",
    definition:
      "Richer workloads that exercise StreamMDX-specific features such as mixed MDX, math, HTML, footnotes, and worker-aware composition. These are shown for behavior inspection, not direct cross-engine claims.",
  },
] as const;

export const BENCHMARK_CONTENT_CLASS_DECISION = {
  totalClasses: 5,
  rationale:
    "The current five-class public set is intentionally final for the active plan: four parity-friendly classes (prose, tables, code, mixed) plus one explicitly marked capability stress class (rich). Adding more public classes is deferred until a distinct behavior family appears that the current set does not already expose.",
} as const;

export function getLiveBenchmarkScheduling(mode: MethodologyMode): StreamingSchedulerOptions {
  return {
    batch: "rAF",
    startupMicrotaskFlushes: mode === "ci-locked" ? 8 : 4,
    adaptiveBudgeting: mode === "ci-locked" ? false : undefined,
  };
}
