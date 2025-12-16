import assert from "node:assert";
import type { RendererMetrics } from "@stream-mdx/react";
import { DEFAULT_BACKPRESSURE_CONFIG, calculateRawCredit, calculateSmoothedCredit, computeHeavyPatchBudget, smoothCredit } from "../src/perf/backpressure";
import { RNG } from "./helpers/rng";

const EPSILON = 0.001;

function approxEqual(actual: number, expected: number, epsilon = EPSILON) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `expected ${expected} but received ${actual}`);
}

type MetricsSample = Pick<
  RendererMetrics,
  "queueDepthBefore" | "remainingQueueSize" | "batchCount" | "priorities" | "queueDelay" | "adaptiveBudget"
> & {
  tx: number;
  receivedAt: number;
  committedAt: number;
  durationMs: number;
  patchToDomMs: number;
  totalPatches: number;
  appliedPatches: number;
};

interface SimulationResult {
  metrics: MetricsSample[];
  credits: number[];
  heavyBudgets: number[];
}

function runBackpressureSimulation(seed: number, iterations: number): SimulationResult {
  const rng = new RNG(seed);
  let credit = 1;
  const metrics: MetricsSample[] = [];
  const credits: number[] = [];
  const heavyBudgets: number[] = [];

  for (let i = 0; i < iterations; i++) {
    const bursty = rng.next() > 0.7;
    const queueDepth = bursty ? rng.next() * 4 + 1.5 : rng.next() * 1.75;
    credit = calculateSmoothedCredit(queueDepth, credit);
    const heavyBudget = computeHeavyPatchBudget(credit);
    credits.push(credit);
    heavyBudgets.push(heavyBudget);

    metrics.push({
      tx: i,
      receivedAt: i * 2,
      committedAt: i * 2 + 1,
      durationMs: rng.int(1, 8),
      patchToDomMs: rng.int(1, 5),
      totalPatches: rng.int(4, 40),
      appliedPatches: rng.int(2, 40),
      queueDepthBefore: queueDepth,
      remainingQueueSize: Math.max(0, queueDepth - (rng.next() * 0.6 + 0.1)),
      batchCount: rng.int(1, 4),
      priorities: heavyBudget === 0 ? ["high"] : ["high", "low"],
      queueDelay: {
        avg: rng.next() * 2,
        max: rng.next() * 6 + 2,
        p95: rng.next() * 4,
      },
      adaptiveBudget:
        credit < 0.5
          ? {
              active: true,
              highBatchCap: 3,
              lowBatchCap: 2,
              activateThresholdMs: 6,
              deactivateThresholdMs: 4,
              lastObservedP95: rng.next() * 6,
            }
          : undefined,
    });
  }

  return { metrics, credits, heavyBudgets };
}

async function main() {
  assert.strictEqual(calculateRawCredit(0), 1);
  assert.strictEqual(calculateRawCredit(DEFAULT_BACKPRESSURE_CONFIG.targetQueueDepth), 1);
  assert.strictEqual(calculateRawCredit(DEFAULT_BACKPRESSURE_CONFIG.maxQueueDepth), 0);
  const midpoint = (DEFAULT_BACKPRESSURE_CONFIG.targetQueueDepth + DEFAULT_BACKPRESSURE_CONFIG.maxQueueDepth) / 2;
  approxEqual(calculateRawCredit(midpoint), 0.5);

  const raw = calculateRawCredit(4);
  const smoothed = smoothCredit(1, raw, DEFAULT_BACKPRESSURE_CONFIG.smoothingFactor);
  approxEqual(smoothed, calculateSmoothedCredit(4, 1));

  assert.strictEqual(computeHeavyPatchBudget(0), 0);
  assert.strictEqual(computeHeavyPatchBudget(0.5), 0);
  assert.strictEqual(computeHeavyPatchBudget(0.6), 2);
  assert.strictEqual(computeHeavyPatchBudget(1), DEFAULT_BACKPRESSURE_CONFIG.maxHeavyPatchBudget);

  const simulation = runBackpressureSimulation(424242, 1500);
  assert.strictEqual(simulation.metrics.length, 1500);
  assert.strictEqual(simulation.credits.length, 1500);
  assert.strictEqual(simulation.heavyBudgets.length, 1500);

  const lowDepthCredits = simulation.metrics
    .map((m, idx) => ({ depth: m.queueDepthBefore, credit: simulation.credits[idx] }))
    .filter(({ depth }) => depth <= DEFAULT_BACKPRESSURE_CONFIG.targetQueueDepth);
  const highDepthCredits = simulation.metrics
    .map((m, idx) => ({ depth: m.queueDepthBefore, credit: simulation.credits[idx] }))
    .filter(({ depth }) => depth >= DEFAULT_BACKPRESSURE_CONFIG.maxQueueDepth);

  const avg = (entries: Array<{ credit: number }>) =>
    entries.reduce((sum, entry) => sum + entry.credit, 0) / Math.max(1, entries.length);

  assert.ok(avg(lowDepthCredits) > avg(highDepthCredits), "credits should be higher for shallow queues");

  simulation.heavyBudgets.forEach((budget, idx) => {
    const credit = simulation.credits[idx];
    if (credit <= DEFAULT_BACKPRESSURE_CONFIG.lowCreditCutoff) {
      assert.strictEqual(budget, 0, "heavy patch budget must be zero when credit is below cutoff");
    } else {
      assert.ok(budget >= DEFAULT_BACKPRESSURE_CONFIG.minHeavyPatchBudget, "budget respects minimum value");
      assert.ok(budget <= DEFAULT_BACKPRESSURE_CONFIG.maxHeavyPatchBudget, "budget respects maximum cap");
    }
  });

  let adaptiveCount = 0;
  simulation.metrics.forEach((sample, idx) => {
    if (!sample.adaptiveBudget?.active) {
      return;
    }
    adaptiveCount++;
    const credit = simulation.credits[idx];
    assert.ok(
      credit < 0.5 || sample.queueDepthBefore >= DEFAULT_BACKPRESSURE_CONFIG.maxQueueDepth,
      "adaptive mode should only engage when credit collapses or queue depth spikes",
    );
  });
  assert.ok(adaptiveCount > 0, "simulation should trigger adaptive budget at least once");

  const remainingQueueTrend = simulation.metrics.reduce(
    (acc, sample) => acc + (sample.queueDepthBefore - sample.remainingQueueSize),
    0,
  );
  assert.ok(remainingQueueTrend > 0, "queue depth should shrink after flush batches on average");

  console.log("Backpressure utility tests passed");
}

await main();
