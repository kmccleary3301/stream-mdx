# Local Perf Baselines

Use this log to track local perf harness runs while hill climbing. Each run writes a `summary.txt` and `summary.json`.

## Latest runs (2026-01-16)
- `tmp/perf-baselines/naive-bayes-S1_slow_small-2026-01-16T06-11-35-608Z`
- `tmp/perf-baselines/naive-bayes-S2_typical-2026-01-16T06-19-37-644Z`
- `tmp/perf-baselines/naive-bayes-S2_typical-2026-01-16T06-23-05-474Z` (includes `--profiler`)
- `tmp/perf-baselines/naive-bayes-S4_chunky_network-2026-01-16T06-21-10-866Z`
- `tmp/perf-baselines/table-large-S2_typical-2026-01-16T06-22-16-932Z`
- `tmp/perf-baselines/table-large-S6_extreme-2026-01-16T06-22-29-600Z`
- `tmp/perf-baselines/naive-bayes-S1_slow_small-2026-01-16T01-23-40-289Z`
- `tmp/perf-baselines/naive-bayes-S2_typical-2026-01-16T01-31-45-659Z`
- `tmp/perf-baselines/naive-bayes-S2_typical-2026-01-16T01-34-57-854Z` (includes `--profiler`)
- `tmp/perf-baselines/naive-bayes-S4_chunky_network-2026-01-16T01-33-19-667Z`
- `tmp/perf-baselines/table-large-S2_typical-2026-01-16T01-34-13-489Z`
- `tmp/perf-baselines/table-large-S6_extreme-2026-01-16T01-34-28-484Z`

Profiler note:
- `naive-bayes/S2_typical` (2026-01-16T06-23-05-474Z): actual p95 8.70 ms, base p95 128.40 ms.

## How to read
1. Open the text summary:
   `cat tmp/perf-baselines/<run>/summary.txt`
2. Check these p95 metrics:
   - `longTaskP95` for jank
   - `rafP95` for animation cadence
   - `memoryPeakMB` for heap growth
3. If `--profiler` is enabled, compare `profilerActual` vs `profilerBase`.

## Rerun commands
```bash
npx tsx scripts/perf/run-perf-harness.ts --fixture naive-bayes --scenario S1_slow_small --runs 3 --warmup 1 --out tmp/perf-baselines
npx tsx scripts/perf/run-perf-harness.ts --fixture naive-bayes --scenario S2_typical --runs 3 --warmup 1 --out tmp/perf-baselines
npx tsx scripts/perf/run-perf-harness.ts --fixture naive-bayes --scenario S2_typical --runs 3 --warmup 1 --out tmp/perf-baselines --profiler
npx tsx scripts/perf/run-perf-harness.ts --fixture naive-bayes --scenario S4_chunky_network --runs 3 --warmup 1 --out tmp/perf-baselines
npx tsx scripts/perf/run-perf-harness.ts --fixture table-large --scenario S2_typical --runs 3 --warmup 1 --out tmp/perf-baselines
npx tsx scripts/perf/run-perf-harness.ts --fixture table-large --scenario S6_extreme --runs 3 --warmup 1 --out tmp/perf-baselines
```
