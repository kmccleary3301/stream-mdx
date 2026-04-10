#!/usr/bin/env tsx

import assert from "node:assert/strict";

import {
  BENCHMARK_CI_PROFILE,
  BENCHMARK_RUNTIME_COST_TERMS,
  BENCHMARK_SCHEDULER_MODES,
  BENCHMARK_STATIC_CONTENT_CLASSES,
  getLiveBenchmarkScheduling,
} from "../apps/docs/lib/benchmark-methodology";

function main() {
  assert.equal(BENCHMARK_CI_PROFILE.chunkChars, 42, "CI chunk size drifted");
  assert.equal(BENCHMARK_CI_PROFILE.intervalMs, 32, "CI interval drifted");
  assert.equal(BENCHMARK_CI_PROFILE.repeatCount, 16, "CI repeat count drifted");
  assert.equal(BENCHMARK_CI_PROFILE.scoredRuns, 5, "CI scored run count drifted");
  assert.equal(BENCHMARK_CI_PROFILE.orderMode, "rotate", "CI order mode drifted");
  assert.equal(BENCHMARK_CI_PROFILE.profile, "parity-gfm", "CI workload profile drifted");
  assert.equal(BENCHMARK_CI_PROFILE.chartLayout, "split", "CI chart layout drifted");

  const ciScheduling = getLiveBenchmarkScheduling("ci-locked");
  assert.equal(ciScheduling.batch, "rAF", "CI scheduling batch should stay rAF");
  assert.equal(ciScheduling.startupMicrotaskFlushes, 8, "CI startup microtask flush count drifted");
  assert.equal(ciScheduling.adaptiveBudgeting, false, "CI adaptive budgeting should stay disabled");

  const exploreScheduling = getLiveBenchmarkScheduling("explore");
  assert.equal(exploreScheduling.batch, "rAF", "Explore scheduling batch should stay rAF");
  assert.equal(exploreScheduling.startupMicrotaskFlushes, 4, "Explore startup microtask flush count drifted");
  assert.equal(exploreScheduling.adaptiveBudgeting, undefined, "Explore mode should not hard-disable adaptive budgeting");

  assert.equal(BENCHMARK_STATIC_CONTENT_CLASSES.length, 5, "Static content classes should cover the five public fixture families");
  assert.equal(BENCHMARK_RUNTIME_COST_TERMS.length, 4, "Runtime cost terminology set should stay explicit");
  assert.equal(BENCHMARK_SCHEDULER_MODES.length, 2, "Scheduler modes should stay intentionally narrow");

  console.log(
    JSON.stringify(
      {
        ok: true,
        ciProfile: BENCHMARK_CI_PROFILE,
        ciScheduling,
        exploreScheduling,
        staticContentClasses: BENCHMARK_STATIC_CONTENT_CLASSES.map((item) => item.id),
        runtimeTerms: BENCHMARK_RUNTIME_COST_TERMS.map((item) => item.name),
        schedulerModes: BENCHMARK_SCHEDULER_MODES.map((item) => item.id),
      },
      null,
      2,
    ),
  );
}

main();
