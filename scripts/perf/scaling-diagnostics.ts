import {
  COUNTER_STAGES,
  type CounterStage,
  type StageCounters,
  type SessionCountersSnapshot,
} from "./counter-sink";
import { reportTableScalingEvidence, type TableBoundaryEvidence, type TableScalingObservation } from "./table-scaling-evidence";
import type { DivergenceReport } from "./replay-fixtures";
import { measureAppendWindowWork, CODE_SOURCE_WORK_COUNTERS, TABLE_SOURCE_WORK_COUNTERS, NATIVE_LIST_SOURCE_WORK_COUNTERS, PARAGRAPH_SOURCE_WORK_COUNTERS, type NativeListOwnerSetupEvidence } from "./scaling-append-window";


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
  workMeasure:
    | "base counters plus source-read/materialization, directory-copy, record-slot, and code-preparation counters; not literal CPU cost"
    | "table source-reader/materialization, parser-input/inline preparation, and engine/store record-slot counters; semantic patch row slots and native row/cell callbacks reported separately; not literal CPU cost"
    | "base counters plus paragraph source-read/materialization, directory-copy, and record-slot counters; paragraph source-range probes, projection visits, and explicit view slots are instrumented; emitted span/source records are asserted separately; not literal CPU cost"
    | "base counters plus native list-primary source-read/materialization, directory-copy, record-slot, and required engine/store/view counters; paragraph view probes/visits/slots are instrumented, while V8 backing-store/splice/Set and React Fiber/layout internals are unmeasured; not literal CPU cost";
  gatePassed: boolean;
  stageRatios: Record<CounterStage, Partial<Record<keyof StageCounters, StageCounterRatio>>>;
  snapshotN: SessionCountersSnapshot;
  snapshot4N: SessionCountersSnapshot;
  ownerEvidence?: { n: NativeListOwnerSetupEvidence; fourN: NativeListOwnerSetupEvidence };
  counterCoverage?: ScalingCounterCoverage;
  tableBoundary?: { n: TableBoundaryEvidence; fourN: TableBoundaryEvidence };
  tableObservations?: TableScalingObservation[];
}


export interface ScalingCounterCoverage {
  status: "partial";
  observedMetrics: readonly string[];
  unmeasuredWork: readonly string[];
}



// Append-only source directories legitimately copy zero entries without root growth.
const REQUIRED_CODE_SOURCE_COUNTERS: readonly {
  readonly stage: CounterStage;
  readonly counter: keyof StageCounters;
}[] = [
  { stage: "engine", counter: "source_units_read" },
  { stage: "engine", counter: "record_slots_allocated" },
  { stage: "engine", counter: "code_source_units_prepared" },
  { stage: "store", counter: "record_slots_allocated" },
  { stage: "store", counter: "store_records_touched" },
] as const;

const REQUIRED_NATIVE_LIST_SOURCE_COUNTERS: readonly {
  readonly stage: CounterStage;
  readonly counter: keyof StageCounters;
}[] = [
  { stage: "engine", counter: "source_units_read" },
  { stage: "engine", counter: "inline_source_units_prepared" },
  { stage: "engine", counter: "record_slots_allocated" },
  { stage: "engine", counter: "prefix_comparisons" },
  { stage: "store", counter: "store_records_touched" },
  { stage: "view", counter: "store_records_touched" },
] as const;



const REQUIRED_PARAGRAPH_SOURCE_COUNTERS: readonly {
  readonly stage: CounterStage;
  readonly counter: keyof StageCounters;
}[] = [
  { stage: "engine", counter: "source_units_read" },
  { stage: "engine", counter: "inline_source_units_prepared" },
  { stage: "engine", counter: "record_slots_allocated" },
  { stage: "store", counter: "record_slots_allocated" },
  { stage: "store", counter: "store_records_touched" },
  { stage: "view", counter: "store_records_touched" },
] as const;


export interface ScalingWorkloadDef {
  name: string;
  expectedBlockType: "paragraph" | "code" | "table" | "list";
  setupPrefixN: string;
  setupPrefix4N: string;
  nPrefixUnits: number;
  fourNPrefixUnits: number;
  appendChunks: string[];
  windowUnits: number;
  codeSourceFrom?: number;
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
  const htmlCodeProlog = "<div>\n\n";
  const htmlCodeSetupN = htmlCodeProlog + cSetupN;
  const htmlCodeSetup4N = htmlCodeProlog + cSetup4N;

  const tChunks = Array.from({ length: 10 }, (_, i) => `| app_a_${i} | app_b_${i} | app_c_${i} |\n`);
  const tSetupN =
    "| Col A | Col B | Col C |\n| :--- | :---: | ---: |\n" +
    Array.from({ length: 20 }, (_, i) => `| cell_a_${i} | cell_b_${i} | cell_c_${i} |\n`).join("");
  const tSetup4N =
    "| Col A | Col B | Col C |\n| :--- | :---: | ---: |\n" +
    Array.from({ length: 80 }, (_, i) => `| cell_a_${i} | cell_b_${i} | cell_c_${i} |\n`).join("");

  const lChunks = Array.from({ length: 10 }, (_, i) =>
    `- appended list item ${String(i).padStart(2, "0")} content.\n`,
  );
  const lSetupN = Array.from({ length: 20 }, (_, i) =>
    `- list item prefix ${String(i).padStart(2, "0")} content.\n`,
  ).join("");
  const lSetup4N = Array.from({ length: 80 }, (_, i) =>
    `- list item prefix ${String(i).padStart(2, "0")} content.\n`,
  ).join("");
  const lpChunks = Array.from({ length: 10 }, (_, i) =>
    `  list primary append ${String(i).padStart(2, "0")} content.\n`,
  );
  const listPrimaryLines = Array.from({ length: 80 }, (_, i) =>
    `${i === 0 ? "- " : "  "}list primary prefix ${String(i).padStart(2, "0")} content.\n`,
  );
  const lpSetupN = listPrimaryLines.slice(0, 20).join("");
  const lpSetup4N = listPrimaryLines.join("");

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
      name: "html-code-lines",
      expectedBlockType: "code",
      setupPrefixN: htmlCodeSetupN,
      setupPrefix4N: htmlCodeSetup4N,
      nPrefixUnits: htmlCodeSetupN.length,
      fourNPrefixUnits: htmlCodeSetup4N.length,
      appendChunks: cChunks,
      windowUnits: cChunks.reduce((acc, c) => acc + c.length, 0),
      codeSourceFrom: htmlCodeProlog.length,
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
    {
      name: "list-primary-paragraph",
      expectedBlockType: "list",
      setupPrefixN: lpSetupN,
      setupPrefix4N: lpSetup4N,
      nPrefixUnits: lpSetupN.length,
      fourNPrefixUnits: lpSetup4N.length,
      appendChunks: lpChunks,
      windowUnits: lpChunks.reduce((acc, c) => acc + c.length, 0),
    },
  ];
}



export async function runScalingDiagnostics(options: {
  codeFamilyOnly?: boolean;
  tableFamilyOnly?: boolean;
} = {}): Promise<{
  measurements: ScalingMeasurement[];
  divergences: DivergenceReport[];
}> {
  if (options.codeFamilyOnly && options.tableFamilyOnly) {
    throw new Error("Select at most one focused scaling family");
  }
  const measurements: ScalingMeasurement[] = [];
  const divergences: DivergenceReport[] = [];
  const selectedBlockType = options.codeFamilyOnly
    ? "code"
    : options.tableFamilyOnly
      ? "table"
      : undefined;
  const workloads = createScalingWorkloads().filter(
    (workload) => selectedBlockType === undefined || workload.expectedBlockType === selectedBlockType,
  );

  for (const wl of workloads) {
    const measurementMode = wl.expectedBlockType === "code"
      ? "code-source"
      : wl.expectedBlockType === "table"
        ? "table-rows"
        : wl.expectedBlockType === "list"
          ? "native-list-source"
          : "paragraph-source";
    const includeCodeSourceWork = measurementMode === "code-source";
    const includeTableBoundary = measurementMode === "table-rows";
    const workCounters = measurementMode === "code-source"
      ? CODE_SOURCE_WORK_COUNTERS
      : measurementMode === "table-rows"
        ? TABLE_SOURCE_WORK_COUNTERS
        : measurementMode === "native-list-source"
          ? NATIVE_LIST_SOURCE_WORK_COUNTERS
          : PARAGRAPH_SOURCE_WORK_COUNTERS;
    try {
      const measuredN = await measureAppendWindowWork(wl, wl.setupPrefixN, measurementMode);
      const measured4N = await measureAppendWindowWork(wl, wl.setupPrefix4N, measurementMode);
      const {
        observedWork: observedWorkN,
        sinkSnapshot: snapN,
        establishedBlockType: establishedN,
        ownerEvidence: ownerEvidenceN,
        tableBoundary: tableBoundaryN,
      } = measuredN;
      const {
        observedWork: observedWork4N,
        sinkSnapshot: snap4N,
        establishedBlockType: established4N,
        ownerEvidence: ownerEvidence4N,
        tableBoundary: tableBoundary4N,
      } = measured4N;

      if (establishedN !== wl.expectedBlockType || established4N !== wl.expectedBlockType) {
        divergences.push({
          fixtureId: `scaling-${wl.name}`,
          planMode: "window-append",
          seed: 0,
          stage: "diagnostic:block-type",
          commitIndex: 0,
          frontier: wl.windowUnits,
          sourcePrefix: wl.setupPrefixN.slice(0, 40),
          message: `Current diagnostic red: workload '${wl.name}' established block type '${establishedN}' instead of expected '${wl.expectedBlockType}'`,
        });
        // Retain other completed per-stage results without recording a fake pass or bogus paragraph measurement.
        continue;
      }

      const workPerUnitN = observedWorkN / wl.windowUnits;
      const workPerUnit4N = observedWork4N / wl.windowUnits;
      const totalRatio = workPerUnitN > 0 ? workPerUnit4N / workPerUnitN : (workPerUnit4N > 0 ? Infinity : 1.0);
      let gatePassed = totalRatio <= 1.25;
      const requiredSourceCounters = includeCodeSourceWork
        ? REQUIRED_CODE_SOURCE_COUNTERS
        : measurementMode === "native-list-source"
          ? REQUIRED_NATIVE_LIST_SOURCE_COUNTERS
          : measurementMode === "paragraph-source"
            ? REQUIRED_PARAGRAPH_SOURCE_COUNTERS
            : undefined;
      if (requiredSourceCounters) {
        for (const { stage, counter } of requiredSourceCounters) {
          const countN = snapN.stages[stage][counter];
          const count4N = snap4N.stages[stage][counter];
          if (countN === 0 || count4N === 0) {
            gatePassed = false;
            divergences.push({
              fixtureId: `scaling-${wl.name}`,
              planMode: "window-append",
              seed: 0,
              stage: `diagnostic:scaling:missing:${stage}:${counter}`,
              commitIndex: wl.appendChunks.length,
              frontier: wl.windowUnits,
              sourcePrefix: wl.appendChunks[0]?.slice(0, 40) ?? "",
              message: `${wl.expectedBlockType}-family counter '${stage}.${counter}' must report observed work in both windows: N=${countN}, 4N=${count4N}`,
            });
          }
        }
      }


      if (measurementMode === "native-list-source" && (!ownerEvidenceN || !ownerEvidence4N)) {
        gatePassed = false;
        divergences.push({
          fixtureId: `scaling-${wl.name}`,
          planMode: "window-append",
          seed: 0,
          stage: "diagnostic:scaling:missing:native-list-owner-evidence",
          commitIndex: wl.appendChunks.length,
          frontier: wl.windowUnits,
          sourcePrefix: wl.appendChunks[0]?.slice(0, 40) ?? "",
          message: "Native list measurement requires actual managed listItemPrimary owner evidence in both N and 4N setup windows.",
        });
      }

      const stageRatios: Record<CounterStage, Partial<Record<keyof StageCounters, StageCounterRatio>>> = {
        engine: {},
        snapshot: {},
        patch: {},
        store: {},
        view: {},
      };

      // A growing stage cannot hide behind a flat aggregate.
      for (const stage of COUNTER_STAGES) {
        for (const counter of workCounters) {
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
                message: `Current scaling red: stage '${stage}' counter '${counter}' ratio ${ratio.toFixed(2)}x exceeds 1.25x gate on ${wl.name} (N work/unit: ${unitWorkN.toFixed(4)}, 4N work/unit: ${unitWork4N.toFixed(4)})`,
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

      const tableObservations: TableScalingObservation[] = [];
      let tableBoundary: { n: TableBoundaryEvidence; fourN: TableBoundaryEvidence } | undefined;
      if (includeTableBoundary) {
        const evidence = reportTableScalingEvidence(
          {
            workloadName: wl.name,
            windowUnits: wl.windowUnits,
            appendChunkCount: wl.appendChunks.length,
            sourcePrefix: wl.appendChunks[0]?.slice(0, 40) ?? "",
            snapshotN: snapN,
            snapshot4N: snap4N,
            tableBoundaryN,
            tableBoundary4N,
            gatePassed,
          },
          (divergence) => {
            divergences.push(divergence);
          },
        );
        gatePassed = evidence.gatePassed;
        tableObservations.push(...evidence.observations);
        tableBoundary = evidence.boundary;
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
          message: `Current scaling red: observed-work ratio ${totalRatio.toFixed(2)}x exceeds 1.25x gate on ${wl.name} (N observed work/input-unit: ${workPerUnitN.toFixed(4)}, 4N observed work/input-unit: ${workPerUnit4N.toFixed(4)})`,
        });
      }

      measurements.push({
        workload: wl.name,
        expectedBlockType: wl.expectedBlockType,
        windowUnits: wl.windowUnits,
        nPrefixUnits: wl.nPrefixUnits,
        workMeasure: includeCodeSourceWork
          ? "base counters plus source-read/materialization, directory-copy, record-slot, and code-preparation counters; not literal CPU cost"
          : includeTableBoundary
            ? "table source-reader/materialization, parser-input/inline preparation, and engine/store record-slot counters; semantic patch row slots and native row/cell callbacks reported separately; not literal CPU cost"
            : measurementMode === "native-list-source"
              ? "base counters plus native list-primary source-read/materialization, directory-copy, record-slot, and required engine/store/view counters; paragraph view probes/visits/slots are instrumented, while V8 backing-store/splice/Set and React Fiber/layout internals are unmeasured; not literal CPU cost"
              : "base counters plus paragraph source-read/materialization, directory-copy, and record-slot counters; paragraph source-range probes, projection visits, and explicit view slots are instrumented; emitted span/source records are asserted separately; not literal CPU cost",
        fourNPrefixUnits: wl.fourNPrefixUnits,
        workPerUnitN,
        workPerUnit4N,
        totalRatio,
        gatePassed,
        stageRatios,
        snapshotN: snapN,
        snapshot4N: snap4N,
        ...(ownerEvidenceN && ownerEvidence4N
          ? { ownerEvidence: { n: ownerEvidenceN, fourN: ownerEvidence4N } }
          : {}),
        ...(measurementMode === "native-list-source"
          ? {
              counterCoverage: {
                status: "partial" as const,
                observedMetrics: [
                  "all legacy per-stage counters, including store Array#indexOf comparison probes",
                  "engine.source_units_read, including native indentation input reads",
                  "engine.inline_source_units_prepared",
                  "engine.prefix_comparisons, including native marker/indentation and reader binary-search probes plus Engine childAtSourceStart lookups",
                  "engine.record_slots_allocated",
                  "store.record_slots_allocated, including explicit inserted child and deduplicated-array slot writes",
                  "store.store_records_touched",
                  "view.store_records_touched, including paragraph source-to-span lookup probes and paragraph projection visits",
                  "view.record_slots_allocated, including explicit paragraph projection/rendered child slots",
                ],
                unmeasuredWork: [
                  "JS engine array backing-store growth, Array#splice relocation, and Set internals are unobservable; counters record explicit source-level slot writes, not engine-managed relocation or collection work.",
                  "React Fiber reconciliation and browser DOM/layout internals are unobservable; mounted list item counts and authored text are asserted, but those engine costs are not counted.",
                ],
              },
            }
          : {}),
        ...(tableBoundary ? { tableBoundary } : {}),
        ...(includeTableBoundary ? { tableObservations } : {}),
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
