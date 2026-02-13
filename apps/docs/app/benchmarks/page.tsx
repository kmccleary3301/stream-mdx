import { PerfHarness } from "@/components/perf/perf-harness";
import { Suspense } from "react";

export const dynamic = "force-static";

export default function BenchmarksPage(): JSX.Element {
  // PerfHarness uses useSearchParams() and needs a Suspense boundary for static export.
  return (
    <Suspense fallback={<div />}>
      <PerfHarness />
    </Suspense>
  );
}
