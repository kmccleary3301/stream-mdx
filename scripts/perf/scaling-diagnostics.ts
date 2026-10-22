import assert from "node:assert";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import type { Patch, WorkerIn, WorkerOut } from "@stream-mdx/core";
import type { RendererStoreOptions } from "@stream-mdx/react/renderer/store";
import type { MarkdownEngineOptions } from "../../packages/markdown-v2-worker/src/engine/types";
import {
  MarkdownEngine,
  createRendererStore,
  ComponentRegistry,
  MarkdownBlocksRenderer,
  SessionCounterSink,
} from "./diagnostic-dist/index.mjs";
import {
  COUNTER_STAGES,
  type CounterStage,
  type StageCounters,
  type SessionCountersSnapshot,
} from "./counter-sink";

export interface DivergenceReport {
  fixtureId: string;
  planMode: string;
  seed: number;
  stage: string;
  commitIndex: number;
  frontier: number;
  sourcePrefix: string;
  message: string;
}

export interface StageCounterRatio {
  n: number;
  fourN: number;
  unitWorkN: number;
  unitWork4N: number;
  ratio: number;
  notApplicable?: boolean;
  available?: boolean;
}

export interface ScalingMeasurement {
  workload: string;
  expectedBlockType: string;
  windowUnits: number;
  nPrefixUnits: number;
  fourNPrefixUnits: number;
  workPerUnitN: number;
  workPerUnit4N: number;
  totalRatio: number;
  workMeasure: "sum of observed counter counts; not literal CPU cost";
  gatePassed: boolean;
  stageRatios: Record<CounterStage, Partial<Record<keyof StageCounters, StageCounterRatio>>>;
  snapshotN: SessionCountersSnapshot;
  snapshot4N: SessionCountersSnapshot;
}

const DOM_GLOBALS = [
  "window",
  "document",
  "HTMLElement",
  "Node",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "navigator",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;

type DomGlobalSnapshot = {
  [K in (typeof DOM_GLOBALS)[number]]?: PropertyDescriptor;
};

function captureDomGlobals(): DomGlobalSnapshot {
  const target = globalThis as unknown as Record<string, unknown>;
  const snapshot: DomGlobalSnapshot = {};
  for (const name of DOM_GLOBALS) {
    snapshot[name] = Object.getOwnPropertyDescriptor(target, name);
  }
  return snapshot;
}

function restoreDomGlobals(snapshot: DomGlobalSnapshot): void {
  const target = globalThis as unknown as Record<string, unknown>;
  for (const name of DOM_GLOBALS) {
    const descriptor = snapshot[name];
    if (descriptor) {
      Object.defineProperty(target, name, descriptor);
    } else {
      delete target[name];
    }
  }
}

const WORK_COUNTERS: readonly (keyof StageCounters)[] = [
  "lines_tokenized",
  "units_tokenized",
  "inline_source_units_prepared",
  "snapshot_nodes_built",
  "prefix_comparisons",
  "patches_emitted",
  "store_records_touched",
  "blocks_reprepared",
] as const;

const SCALING_INIT: WorkerIn = {
  type: "INIT",
  initialContent: "",
  prewarmLangs: ["typescript", "javascript", "markdown"],
  docPlugins: {
    footnotes: true,
    html: true,
    mdx: false,
    tables: true,
    callouts: false,
    math: true,
    formatAnticipation: { inline: true, mathInline: true, mathBlock: true, html: true, mdx: false, regex: false },
    codeHighlighting: "incremental",
    outputMode: "both",
    emitHighlightTokens: true,
    emitDiffBlocks: false,
    themes: { dark: "github-dark", light: "github-light" },
  },
  mdx: { compileMode: "server" },
};

export interface ScalingWorkloadDef {
  name: string;
  expectedBlockType: "paragraph" | "code" | "table" | "list";
  setupPrefixN: string;
  setupPrefix4N: string;
  nPrefixUnits: number;
  fourNPrefixUnits: number;
  appendChunks: string[];
  windowUnits: number;
}

export function createScalingWorkloads(): ScalingWorkloadDef[] {
  const pChunks = Array.from({ length: 10 }, (_, i) => `Appended paragraph line ${i}.\n`);
  const pSetupN = Array.from({ length: 20 }, (_, i) => `Prefix paragraph line ${i} content.\n`).join("");
  const pSetup4N = Array.from({ length: 80 }, (_, i) => `Prefix paragraph line ${i} content.\n`).join("");

  const cChunks = Array.from({ length: 10 }, (_, i) => `  const append_code_${i} = ${100 + i};\n`);
  const cSetupN =
    "```typescript\n" +
    Array.from({ length: 20 }, (_, i) => `  const code_prefix_${i} = ${i};\n`).join("");
  const cSetup4N =
    "```typescript\n" +
    Array.from({ length: 80 }, (_, i) => `  const code_prefix_${i} = ${i};\n`).join("");

  const tChunks = Array.from({ length: 10 }, (_, i) => `| app_a_${i} | app_b_${i} | app_c_${i} |\n`);
  const tSetupN =
    "| Col A | Col B | Col C |\n| :--- | :---: | ---: |\n" +
    Array.from({ length: 20 }, (_, i) => `| cell_a_${i} | cell_b_${i} | cell_c_${i} |\n`).join("");
  const tSetup4N =
    "| Col A | Col B | Col C |\n| :--- | :---: | ---: |\n" +
    Array.from({ length: 80 }, (_, i) => `| cell_a_${i} | cell_b_${i} | cell_c_${i} |\n`).join("");

  const lChunks = Array.from({ length: 10 }, (_, i) => `- appended list item ${i}\n`);
  const lSetupN = Array.from({ length: 20 }, (_, i) => `- list item prefix ${i}\n`).join("");
  const lSetup4N = Array.from({ length: 80 }, (_, i) => `- list item prefix ${i}\n`).join("");

  return [
    {
      name: "paragraph",
      expectedBlockType: "paragraph",
      setupPrefixN: pSetupN,
      setupPrefix4N: pSetup4N,
      nPrefixUnits: pSetupN.length,
      fourNPrefixUnits: pSetup4N.length,
      appendChunks: pChunks,
      windowUnits: pChunks.reduce((acc, c) => acc + c.length, 0),
    },
    {
      name: "code-lines",
      expectedBlockType: "code",
      setupPrefixN: cSetupN,
      setupPrefix4N: cSetup4N,
      nPrefixUnits: cSetupN.length,
      fourNPrefixUnits: cSetup4N.length,
      appendChunks: cChunks,
      windowUnits: cChunks.reduce((acc, c) => acc + c.length, 0),
    },
    {
      name: "table-rows",
      expectedBlockType: "table",
      setupPrefixN: tSetupN,
      setupPrefix4N: tSetup4N,
      nPrefixUnits: tSetupN.length,
      fourNPrefixUnits: tSetup4N.length,
      appendChunks: tChunks,
      windowUnits: tChunks.reduce((acc, c) => acc + c.length, 0),
    },
    {
      name: "list-items",
      expectedBlockType: "list",
      setupPrefixN: lSetupN,
      setupPrefix4N: lSetup4N,
      nPrefixUnits: lSetupN.length,
      fourNPrefixUnits: lSetup4N.length,
      appendChunks: lChunks,
      windowUnits: lChunks.reduce((acc, c) => acc + c.length, 0),
    },
  ];
}

async function measureAppendWindowWork(
  workload: ScalingWorkloadDef,
  prefix: string,
): Promise<{ observedWork: number; sinkSnapshot: SessionCountersSnapshot; establishedBlockType: string }> {
  const snapshot = captureDomGlobals();
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
    pretendToBeVisual: true,
  });

  const target = globalThis as unknown as Record<string, unknown>;
  target.window = dom.window;
  target.document = dom.window.document;
  target.HTMLElement = dom.window.HTMLElement;
  target.Node = dom.window.Node;
  target.IS_REACT_ACT_ENVIRONMENT = true;
  target.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  target.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    writable: true,
    value: dom.window.navigator,
  });

  const rootContainer = dom.window.document.getElementById("root");
  assert.ok(rootContainer, "JSDOM root container must exist");
  const root = createRoot(rootContainer);
  const registry = new ComponentRegistry();

  const sessionSink = new SessionCounterSink();
  const store = createRendererStore(undefined, {
    campaignCounters: sessionSink,
  } as RendererStoreOptions & { campaignCounters?: SessionCounterSink });

  const engine = new MarkdownEngine({
    post: (msg: WorkerOut) => {
      if (msg.type === "INITIALIZED") {
        store.reset(msg.blocks);
      } else if (msg.type === "PATCH") {
        store.applyPatches(msg.patches as Patch[]);
      }
    },
    campaignCounters: sessionSink,
  } as MarkdownEngineOptions & { campaignCounters?: SessionCounterSink });

  try {
    await engine.handle(SCALING_INIT);
    if (prefix.length > 0) {
      await engine.handle({ type: "APPEND", text: prefix });
    }

    // Inspect actual resulting block type before resetting counters
    const setupBlocks = store.getBlocks();
    const matchingBlock = setupBlocks.find((b) => b.type === workload.expectedBlockType);
    const establishedBlockType = matchingBlock ? matchingBlock.type : (setupBlocks[0]?.type ?? "none");

    await act(async () => {
      root.render(
        createElement(MarkdownBlocksRenderer, {
          blocks: setupBlocks,
          componentRegistry: registry,
          store,
        }),
      );
      await new Promise<void>((resolve) => dom.window.requestAnimationFrame(() => resolve()));
    });

    // Reset diagnostic counts AFTER setup to isolate the append window
    sessionSink.reset();

    // Execute the SAME bounded append window (no FINALIZE, no backward invalidation)
    for (const chunk of workload.appendChunks) {
      await act(async () => {
        await engine.handle({ type: "APPEND", text: chunk });
        // Observe the real store rAF notification and native subscribers, not a forced duplicate view.
        await new Promise<void>((resolve) => dom.window.requestAnimationFrame(() => resolve()));
      });
    }

    const snap = sessionSink.snapshot();
    const observedWork =
      snap.lines_tokenized +
      snap.units_tokenized +
      snap.inline_source_units_prepared +
      snap.snapshot_nodes_built +
      snap.prefix_comparisons +
      snap.patches_emitted +
      snap.store_records_touched +
      snap.blocks_reprepared;

    return { observedWork, sinkSnapshot: snap, establishedBlockType };
  } finally {
    try {
      await act(async () => root.unmount());
    } finally {
      restoreDomGlobals(snapshot);
      dom.window.close();
      engine.dispose();
    }
  }
}

export async function runScalingDiagnostics(): Promise<{
  measurements: ScalingMeasurement[];
  divergences: DivergenceReport[];
}> {
  const measurements: ScalingMeasurement[] = [];
  const divergences: DivergenceReport[] = [];
  const workloads = createScalingWorkloads();

  for (const wl of workloads) {
    try {
      const { observedWork: observedWorkN, sinkSnapshot: snapN, establishedBlockType: establishedN } = await measureAppendWindowWork(
        wl,
        wl.setupPrefixN,
      );
      const { observedWork: observedWork4N, sinkSnapshot: snap4N, establishedBlockType: established4N } = await measureAppendWindowWork(
        wl,
        wl.setupPrefix4N,
      );

      if (establishedN !== wl.expectedBlockType || established4N !== wl.expectedBlockType) {
        divergences.push({
          fixtureId: `scaling-${wl.name}`,
          planMode: "window-append",
          seed: 0,
          stage: "diagnostic:block-type",
          commitIndex: 0,
          frontier: wl.windowUnits,
          sourcePrefix: wl.setupPrefixN.slice(0, 40),
          message: `Inherited red: workload '${wl.name}' established block type '${establishedN}' instead of expected '${wl.expectedBlockType}'`,
        });
        // Retain other completed per-stage results without recording a fake pass or bogus paragraph measurement
        continue;
      }

    const workPerUnitN = observedWorkN / wl.windowUnits;
    const workPerUnit4N = observedWork4N / wl.windowUnits;
    const totalRatio = workPerUnitN > 0 ? workPerUnit4N / workPerUnitN : (workPerUnit4N > 0 ? Infinity : 1.0);
    let gatePassed = totalRatio <= 1.25;

    const stageRatios: Record<CounterStage, Partial<Record<keyof StageCounters, StageCounterRatio>>> = {
      engine: {},
      snapshot: {},
      patch: {},
      store: {},
      view: {},
    };

    // A growing stage cannot hide behind a flat aggregate.
    for (const stage of COUNTER_STAGES) {
      for (const counter of WORK_COUNTERS) {
        const countN = snapN.stages[stage][counter];
        const count4N = snap4N.stages[stage][counter];

        if (countN > 0 || count4N > 0) {
          const unitWorkN = countN / wl.windowUnits;
          const unitWork4N = count4N / wl.windowUnits;
          const ratio = unitWorkN > 0 ? unitWork4N / unitWorkN : (unitWork4N > 0 ? Infinity : 1.0);

          stageRatios[stage][counter] = {
            n: countN,
            fourN: count4N,
            unitWorkN,
            unitWork4N,
            ratio,
            ...(stage === "view" && counter === "store_records_touched"
              ? { available: countN > 0 && count4N > 0 }
              : {}),
          };

          if (ratio > 1.25) {
            gatePassed = false;
            divergences.push({
              fixtureId: `scaling-${wl.name}`,
              planMode: "window-append",
              seed: 0,
              stage: `diagnostic:scaling:${stage}:${counter}`,
              commitIndex: wl.appendChunks.length,
              frontier: wl.windowUnits,
              sourcePrefix: wl.appendChunks[0]?.slice(0, 40) ?? "",
              message: `Inherited scaling red: stage '${stage}' counter '${counter}' ratio ${ratio.toFixed(2)}x exceeds 1.25x gate on ${wl.name} (N work/unit: ${unitWorkN.toFixed(4)}, 4N work/unit: ${unitWork4N.toFixed(4)})`,
            });
          }
        } else {
          stageRatios[stage][counter] = {
            n: 0,
            fourN: 0,
            unitWorkN: 0,
            unitWork4N: 0,
            ratio: 1.0,
            ...(stage === "view" && counter === "store_records_touched"
              ? { available: false }
              : { notApplicable: true }),
          };
        }
      }
    }

    const viewWorkN = snapN.stages.view.store_records_touched;
    const viewWork4N = snap4N.stages.view.store_records_touched;
    if (viewWorkN === 0 || viewWork4N === 0) {
      gatePassed = false;
      divergences.push({
        fixtureId: `scaling-${wl.name}`,
        planMode: "window-append",
        seed: 0,
        stage: "diagnostic:scaling:view",
        commitIndex: wl.appendChunks.length,
        frontier: wl.windowUnits,
        sourcePrefix: wl.appendChunks[0]?.slice(0, 40) ?? "",
        message: `Observed view work unavailable for ${wl.expectedBlockType} consumer on ${wl.name}: N=${viewWorkN}, 4N=${viewWork4N}; both measurements require nonzero view records`,
      });
    }

    if (totalRatio > 1.25) {
      divergences.push({
        fixtureId: `scaling-${wl.name}`,
        planMode: "window-append",
        seed: 0,
        stage: "diagnostic:scaling",
        commitIndex: wl.appendChunks.length,
        frontier: wl.windowUnits,
        sourcePrefix: wl.appendChunks[0]?.slice(0, 40) ?? "",
        message: `Inherited scaling red: observed-work ratio ${totalRatio.toFixed(2)}x exceeds 1.25x gate on ${wl.name} (N observed work/input-unit: ${workPerUnitN.toFixed(4)}, 4N observed work/input-unit: ${workPerUnit4N.toFixed(4)})`,
      });
    }

    measurements.push({
      workload: wl.name,
      expectedBlockType: wl.expectedBlockType,
      windowUnits: wl.windowUnits,
      nPrefixUnits: wl.nPrefixUnits,
      workMeasure: "sum of observed counter counts; not literal CPU cost",
      fourNPrefixUnits: wl.fourNPrefixUnits,
      workPerUnitN,
      workPerUnit4N,
      totalRatio,
      gatePassed,
      stageRatios,
      snapshotN: snapN,
      snapshot4N: snap4N,
    });
    } catch (err) {
      divergences.push({
        fixtureId: `scaling-${wl.name}`,
        planMode: "window-append",
        seed: 0,
        stage: "diagnostic:scaling:error",
        commitIndex: 0,
        frontier: wl.windowUnits,
        sourcePrefix: wl.setupPrefixN.slice(0, 40),
        message: `Workload '${wl.name}' failed during measurement: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }
  }

  return { measurements, divergences };
}
