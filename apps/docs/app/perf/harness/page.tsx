import { Suspense } from "react";

import { PerfHarness } from "@/components/perf/perf-harness";

export default function PerfHarnessPage(): JSX.Element {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading perf harness…</div>}>
      <PerfHarness />
    </Suspense>
  );
}
