# StreamMDX Perf Quality Changelog

This log tracks perf harness snapshots used to make scheduling decisions. Values are p95 unless noted. Paths point to local `tmp/` outputs.

## 2026-01-13 Long-task filtering to stream window

Change:
- Long-task stats now only consider tasks occurring between `runStart` and `runEnd`.
- This removes page-load noise from perf results and makes stutter attribution more accurate.

Baselines refreshed from:
- `tmp/perf-runs/naive-bayes-S2_typical-2026-01-13T02-40-09-035Z`
- `tmp/perf-runs/naive-bayes-S3_fast_reasonable-2026-01-13T02-39-22-647Z`

## 2026-01-09 Aggressive default scheduling

Baseline:
- `tmp/perf-baselines/S2_typical`
- `tmp/perf-baselines/S3_fast_reasonable`

Candidate (aggressive default):
- `tmp/perf-runs/naive-bayes-S2_typical-2026-01-09T20-33-31-324Z`
- `tmp/perf-runs/naive-bayes-S3_fast_reasonable-2026-01-09T20-35-43-534Z`

S2_typical vs baseline:
- duration p95: 19065.10 ms -> 18982.60 ms (-0.4%)
- first flush p95: 422.30 ms -> 239.30 ms (-43.3%)
- longtask p95 (run p95s): 597.00 ms -> 404.00 ms (-32.3%)
- raf delta p95 (run p95s): 16.80 ms -> 16.80 ms (0.0%)
- memory peak p95: 87.45 MB -> 87.45 MB (0.0%)

S3_fast_reasonable vs baseline:
- duration p95: 7632.10 ms -> 7627.60 ms (-0.1%)
- first flush p95: 276.60 ms -> 268.50 ms (-2.9%)
- longtask p95 (run p95s): 420.00 ms -> 422.00 ms (+0.5%)
- raf delta p95 (run p95s): 16.80 ms -> 16.80 ms (0.0%)
- memory peak p95: 87.45 MB -> 87.45 MB (0.0%)

Smooth vs aggressive comparison (3 runs + warmup):
- smooth S2: `tmp/perf-runs/naive-bayes-S2_typical-2026-01-09T20-36-48-998Z`
- smooth S3: `tmp/perf-runs/naive-bayes-S3_fast_reasonable-2026-01-09T20-38-18-288Z`

S2_typical smooth -> aggressive:
- first flush p95: 276.20 ms -> 239.30 ms (-13.4%)
- longtask p95 (run p95s): 433.00 ms -> 404.00 ms (-6.7%)

S3_fast_reasonable smooth -> aggressive:
- first flush p95: 262.50 ms -> 268.50 ms (+2.3%)
- longtask p95 (run p95s): 434.00 ms -> 422.00 ms (-2.8%)

## 2026-01-09 Baseline refresh (aggressive defaults in @stream-mdx/react)

Baselines updated from:
- `tmp/perf-runs/naive-bayes-S2_typical-2026-01-09T23-26-15-474Z`
- `tmp/perf-runs/naive-bayes-S3_fast_reasonable-2026-01-09T23-28-41-343Z`

Smooth vs aggressive (new baseline) comparison:
- smooth S2: `tmp/perf-runs/naive-bayes-S2_typical-2026-01-09T23-45-11-719Z`
- smooth S3: `tmp/perf-runs/naive-bayes-S3_fast_reasonable-2026-01-09T23-46-49-380Z`

S2_typical smooth -> aggressive:
- first flush p95: 541.10 ms -> 335.20 ms (-38.1%)
- longtask p95 (run p95s): 519.00 ms -> 601.00 ms (+15.8%)
- raf delta p95 (run p95s): 16.80 ms -> 33.30 ms (+98.2%)

S3_fast_reasonable smooth -> aggressive:
- first flush p95: 278.30 ms -> 417.40 ms (+50.0%)
- longtask p95 (run p95s): 477.00 ms -> 525.00 ms (+10.1%)

## 2026-01-10 Adaptive switch (aggressive -> smooth after first flush)

Candidate runs:
- `tmp/perf-runs/naive-bayes-S2_typical-2026-01-10T00-23-35-054Z`
- `tmp/perf-runs/naive-bayes-S3_fast_reasonable-2026-01-10T00-25-49-205Z`

S2_typical vs previous baseline:
- first flush p95: 335.20 ms -> 302.00 ms (-9.9%)
- longtask p95 (run p95s): 601.00 ms -> 485.00 ms (-19.3%)
- raf delta p95 (run p95s): 33.30 ms -> 16.80 ms (-49.5%)

S3_fast_reasonable vs previous baseline:
- first flush p95: 417.40 ms -> 281.50 ms (-32.6%)
- longtask p95 (run p95s): 525.00 ms -> 454.00 ms (-13.5%)
- raf delta p95 (run p95s): 33.30 ms -> 16.80 ms (-49.5%)

Baselines refreshed from the candidate runs above.

## 2026-01-10 Baseline refresh (adaptive switch, 7 runs + warmup)

Baselines updated from:
- `tmp/perf-runs/naive-bayes-S2_typical-2026-01-10T04-19-04-852Z`
- `tmp/perf-runs/naive-bayes-S3_fast_reasonable-2026-01-10T04-21-56-247Z`
