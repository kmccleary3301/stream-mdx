import { STREAM_MDX_SCHEMA_VERSION } from "@stream-mdx/core";

import { createElement, createRef } from "react";
import { createRoot } from "react-dom/client";
import type { WorkerIn, WorkerOut } from "@stream-mdx/core";
import {
  SourceCapacityError,
  StreamingMarkdown,
  type AppendResult,
  type FinalizeResult,
  type StreamingMarkdownHandle,
  type StreamingMarkdownProps,
} from "@stream-mdx/react";
import { CAMPAIGN_OBSERVATIONS } from "./campaign-portfolio";
import { PublicationProgressTracker, type PublicationProgressSnapshot } from "./progress-observation";
import { readProgressObservationTrace } from "./progress-observation-protocol";

const observation = CAMPAIGN_OBSERVATIONS["code-262k"];
const fixture = observation.getFixture();
const trace = observation.getTrace();
const featurePolicy: NonNullable<StreamingMarkdownProps["features"]> = {
  html: true,
  tables: true,
  math: true,
  mdx: false,
  callouts: false,
  footnotes: true,
  formatAnticipation: {
    inline: true,
    mathInline: true,
    mathBlock: true,
    html: true,
    mdx: false,
    regex: false,
  },
  codeHighlighting: "incremental",
  liveCodeHighlighting: true,
  emitDiffBlocks: false,
};
const scheduling: NonNullable<StreamingMarkdownProps["scheduling"]> = {
  batch: "microtask",
  frameBudgetMs: 10,
  maxBatchesPerFlush: 12,
  lowPriorityFrameBudgetMs: 6,
  maxLowPriorityBatchesPerFlush: 2,
  urgentQueueThreshold: 4,
};
const MAX_VISIBLE_LINES_PER_SAMPLE = 64;
const MAX_VISIBILITY_SAMPLES = 200;
const VISIBILITY_SAMPLE_INTERVAL_MS = 100;
const VIEWPORT_POINT_STEP_PX = 12;
const VIEWPORT_POINT_LIMIT = 80;
const LINE_POINT_OFFSETS_PX = [16, 32, 64, 128, 256, 512] as const;
const HOST_FINALIZATION_TIMEOUT_MS = 15_000;

interface SourceLineRange {
  readonly lineNumber: number;
  readonly from: number;
  readonly to: number;
  readonly text: string;
}

interface VisibleLineSample {
  readonly lineNumber: number;
  readonly sourceRangeUTF16: { readonly from: number; readonly to: number } | null;
  readonly sourceTextMatchesFixture: boolean | null;
  readonly visibleTextUTF16Length: number;
  readonly viewportRect: { readonly top: number; readonly left: number; readonly width: number; readonly height: number };
  readonly shikiSpecificDecoration: "positive" | "unknown";
}

interface VisibilitySample {
  readonly sampledAtMs: number;
  readonly lines: readonly VisibleLineSample[];
}

interface ProgressObservationReport {
  schemaVersion: 1;
  status: "starting" | "ready" | "running" | "complete" | "error";
  identity: {
    observationId: string;
    fixtureSha256: string;
    computedFixtureSha256: string | null;
    traceSha256: string;
    computedTraceSha256: string | null;
    fixtureUnitsUTF16: number;
    expectedChunkCount: number;
    scenario: typeof observation.scenario;
    featurePolicy: typeof featurePolicy;
    scheduling: typeof scheduling;
    worker: {
      url: string;
      moduleWorker: boolean;
      constructorName: string;
    } | null;
    userAgent: string;
  };
  frontiers: {
    offeredUnitsUTF16: number;
    acceptedUnitsUTF16: number;
    dispatchedUnitsUTF16: number;
    engineEnteredUTF16Frontier: number;
    parsedUTF16Frontier: number;
    fullySemanticAppliedUTF16Frontier: number;
  };
  traceConsumption: {
    expectedOrdinals: number;
    offeredOrdinals: number;
    acceptedOrdinals: number;
    dispatchedOrdinals: number;
    offeredOrderExact: boolean;
    acceptedOrderExact: boolean;
    dispatchedOrderExact: boolean;
    complete: boolean;
  };
  authoredSourceEquality: {
    checked: boolean;
    exact: boolean | null;
    offeredUnitsUTF16: number;
    fixtureUnitsUTF16: number;
  };
  traceEvents: {
    document: number;
    engineEntered: number;
    parsedPublication: number;
    patchWorkerOut: number;
    flushResults: number;
    workerOutputTypes: Record<string, number>;
  };
  lifecycle: {
    rendererWorkerReadyAtMs: number | null;
    workerInitializedAtMs: number | null;
    producerStartedAtMs: number | null;
    producerCompletedAtMs: number | null;
    finalizeRequestedAtMs: number | null;
    workerFinalizedAtMs: number | null;
    semanticDrainCompletedAtMs: number | null;
    hostFinalizationResult: FinalizeResult | null;
    nativeAdmissionGeneration: number | null;
    semanticDrainComplete: boolean | null;
    nativeFinalizedGeneration: number | null;
    producerTicks: Array<{ ordinal: number; nominalAtMs: number; actualAtMs: number; latenessMs: number }>;
  };
  publicationProgress: PublicationProgressSnapshot | null;
  visibility: {
    sourceMapping: "precomputed from authored fixture source, excluding fenced-block delimiters";
    sourceLineCount: number;
    droppedSamples: number;
    samples: VisibilitySample[];
  };
  resources: {
    workerCpu: { available: false; reason: string };
    workerHeap: { available: false; reason: string };
  };
  errors: string[];
}

let sourceLineRanges: SourceLineRange[] = [];
let visibilitySamplesDropped = 0;

interface ProgressObservationWindow extends Window {
  __streamMdxProgressObservationReady?: boolean;
  __streamMdxProgressObservationReport?: ProgressObservationReport;
}

const progressWindow = window as ProgressObservationWindow;
const tracker = new PublicationProgressTracker();
const handleRef = createRef<StreamingMarkdownHandle>();
const outputRoot = document.getElementById("output");
const statusNode = document.getElementById("status");
const root = outputRoot ? createRoot(outputRoot) : null;
const errors: string[] = [];
const authoredChunks: string[] = [];
const workerOutputTypes: Record<string, number> = {};
const traceEventCounts = { document: 0, engineEntered: 0, parsedPublication: 0 };
const producerTicks: ProgressObservationReport["lifecycle"]["producerTicks"] = [];
const visibleSamples: VisibilitySample[] = [];
const frontendCounters = { offered: 0, accepted: 0, dispatched: 0 };
const ordinalCounters = { offered: 0, accepted: 0, dispatched: 0 };
const ordinalChecks = { offered: true, accepted: true, dispatched: true };
const workerOutputEvents = { patch: 0, flush: 0 };
const lifecycle = {
  rendererWorkerReadyAtMs: null as number | null,
  workerInitializedAtMs: null as number | null,
  producerStartedAtMs: null as number | null,
  producerCompletedAtMs: null as number | null,
  finalizeRequestedAtMs: null as number | null,
  hostFinalizationResult: null as FinalizeResult | null,
  nativeAdmissionGeneration: null as number | null,
  workerFinalizedAtMs: null as number | null,
  nativeFinalizedGeneration: null as number | null,
  semanticDrainCompletedAtMs: null as number | null,
  semanticDrainComplete: null as boolean | null,
};
const report: ProgressObservationReport = {
  schemaVersion: 1,
  status: "starting",
  identity: {
    observationId: observation.id,
    fixtureSha256: observation.fixtureHash,
    computedFixtureSha256: null,
    traceSha256: observation.traceHash,
    computedTraceSha256: null,
    fixtureUnitsUTF16: fixture.length,
    expectedChunkCount: observation.chunkCount,
    scenario: observation.scenario,
    featurePolicy,
    scheduling,
    worker: null,
    userAgent: navigator.userAgent,
  },
  frontiers: {
    offeredUnitsUTF16: 0,
    acceptedUnitsUTF16: 0,
    dispatchedUnitsUTF16: 0,
    engineEnteredUTF16Frontier: 0,
    parsedUTF16Frontier: 0,
    fullySemanticAppliedUTF16Frontier: 0,
  },
  traceConsumption: {
    expectedOrdinals: trace.length,
    offeredOrdinals: 0,
    acceptedOrdinals: 0,
    dispatchedOrdinals: 0,
    offeredOrderExact: true,
    acceptedOrderExact: true,
    dispatchedOrderExact: true,
    complete: false,
  },
  authoredSourceEquality: {
    checked: false,
    exact: null,
    offeredUnitsUTF16: 0,
    fixtureUnitsUTF16: fixture.length,
  },
  traceEvents: {
    document: 0,
    engineEntered: 0,
    parsedPublication: 0,
    patchWorkerOut: 0,
    flushResults: 0,
    workerOutputTypes,
  },
  lifecycle: {
    ...lifecycle,
    producerTicks,
  },
  publicationProgress: null,
  visibility: {
    sourceMapping: "precomputed from authored fixture source, excluding fenced-block delimiters",
    sourceLineCount: 0,
    droppedSamples: 0,
    samples: visibleSamples,
  },
  resources: {
    workerCpu: {
      available: false,
      reason: "Worker CPU was not observed; page main-thread measurements are not a Worker CPU proxy.",
    },
    workerHeap: {
      available: false,
      reason: "Worker heap was not observed; page performance.memory is not a Worker heap measurement.",
    },
  },
  errors,
};

let activeGeneration: number | null = null;
let initAcknowledgement: ((initialized: boolean) => void) | null = null;
let activeHandle: StreamingMarkdownHandle | null = null;
let hostFinalization: Promise<FinalizeResult> | null = null;
let finalizationDeadline: number | null = null;
let removeFlushListener: (() => void) | null = null;
let codeFrame: HTMLDivElement | null = null;
let tickTimer: number | null = null;
let visibilityTimer: number | null = null;
let producerStartAt = 0;
let traceOrdinal = 0;
let stopped = false;

function clearFinalizationDeadline(): void {
  if (finalizationDeadline === null) return;
  window.clearTimeout(finalizationDeadline);
  finalizationDeadline = null;
}

function armFinalizationDeadline(phase: string): void {
  clearFinalizationDeadline();
  finalizationDeadline = window.setTimeout(() => {
    finalizationDeadline = null;
    recordError(`Timed out waiting for ${phase} after ${HOST_FINALIZATION_TIMEOUT_MS}ms.`, true);
  }, HOST_FINALIZATION_TIMEOUT_MS);
}

function elapsedMs(): number {
  return performance.now();
}

function refreshReport(): void {
  const progress = activeGeneration === null ? null : tracker.snapshot();
  report.status = stopped && errors.length > 0 ? "error" : report.status;
  report.frontiers = {
    offeredUnitsUTF16: frontendCounters.offered,
    acceptedUnitsUTF16: frontendCounters.accepted,
    dispatchedUnitsUTF16: frontendCounters.dispatched,
    engineEnteredUTF16Frontier: progress?.engineEnteredUTF16Frontier ?? 0,
    parsedUTF16Frontier: progress?.parsedUTF16Frontier ?? 0,
    fullySemanticAppliedUTF16Frontier: progress?.fullySemanticAppliedUTF16Frontier ?? 0,
  };
  report.traceConsumption = {
    expectedOrdinals: trace.length,
    offeredOrdinals: ordinalCounters.offered,
    acceptedOrdinals: ordinalCounters.accepted,
    dispatchedOrdinals: ordinalCounters.dispatched,
    offeredOrderExact: ordinalChecks.offered,
    acceptedOrderExact: ordinalChecks.accepted,
    dispatchedOrderExact: ordinalChecks.dispatched,
    complete:
      ordinalCounters.offered === trace.length &&
      ordinalCounters.accepted === trace.length &&
      ordinalCounters.dispatched === trace.length &&
      ordinalChecks.offered &&
      ordinalChecks.accepted &&
      ordinalChecks.dispatched,
  };
  report.authoredSourceEquality.offeredUnitsUTF16 = frontendCounters.offered;
  report.traceEvents = {
    ...traceEventCounts,
    patchWorkerOut: workerOutputEvents.patch,
    flushResults: workerOutputEvents.flush,
    workerOutputTypes,
  };
  report.lifecycle = { ...lifecycle, producerTicks };
  report.publicationProgress = progress;
  report.visibility = {
    sourceMapping: "precomputed from authored fixture source, excluding fenced-block delimiters",
    sourceLineCount: sourceLineRanges.length,
    droppedSamples: visibilitySamplesDropped,
    samples: visibleSamples,
  };
  report.errors = errors;
  progressWindow.__streamMdxProgressObservationReport = report;
}

function setStatus(text: string): void {
  if (statusNode) statusNode.textContent = text;
}

function recordError(message: string, stopProducer = false): void {
  if (!errors.includes(message)) errors.push(message);
  if (stopProducer) {
    stopped = true;
    clearFinalizationDeadline();
    if (tickTimer !== null) {
      window.clearTimeout(tickTimer);
      tickTimer = null;
    }
    if (visibilityTimer !== null) {
      window.clearInterval(visibilityTimer);
      visibilityTimer = null;
    }
  }
  if (statusNode) statusNode.textContent = `Observation error: ${message}`;
  refreshReport();
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function precomputeCodeSourceRanges(source: string): SourceLineRange[] {
  const openingFence = "```typescript\n";
  const openingAt = source.indexOf(openingFence);
  const closingAt = source.lastIndexOf("\n```");
  if (openingAt < 0 || closingAt < openingAt + openingFence.length) {
    recordError("Unable to map authored code lines from the campaign fixture source.");
    return [];
  }

  const ranges: SourceLineRange[] = [];
  let from = openingAt + openingFence.length;
  let lineNumber = 1;
  while (from < closingAt) {
    const newlineAt = source.indexOf("\n", from);
    const to = newlineAt < 0 || newlineAt >= closingAt ? closingAt : newlineAt;
    ranges.push({ lineNumber, from, to, text: source.slice(from, to) });
    if (to >= closingAt) break;
    from = to + 1;
    lineNumber += 1;
  }
  return ranges;
}

sourceLineRanges = precomputeCodeSourceRanges(fixture);
report.visibility.sourceLineCount = sourceLineRanges.length;

function isAppendMessage(value: unknown): value is Extract<WorkerIn, { type: "APPEND" }> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "type" in value &&
    value.type === "APPEND" &&
    "text" in value &&
    typeof value.text === "string"
  );
}

function observeDispatchedAppend(text: string): void {
  const expected = trace[ordinalCounters.dispatched];
  if (!expected || expected.text !== text) {
    ordinalChecks.dispatched = false;
    recordError(`Worker APPEND ordinal ${ordinalCounters.dispatched} did not match the frozen campaign trace.`);
  }
  ordinalCounters.dispatched += 1;
  frontendCounters.dispatched += text.length;
  refreshReport();
}

function installWorkerInstrumentation(worker: Worker): void {
  worker.addEventListener("message", (event: MessageEvent<unknown>) => {
    const traceMessage = readProgressObservationTrace(event.data);
    if (traceMessage.marked) {
      event.stopImmediatePropagation();
      if (!traceMessage.event) {
        recordError("Marked progress trace postMessage contained an invalid event.");
        return;
      }

      const progressEvent = traceMessage.event;
      switch (progressEvent.type) {
        case "document":
          traceEventCounts.document += 1;
          if (traceEventCounts.document > 1) {
            recordError("Received duplicate document trace generation in the single-document observation.");
          }
          break;
        case "engine-entered":
          traceEventCounts.engineEntered += 1;
          break;
        case "parsed-publication":
          traceEventCounts.parsedPublication += 1;
          break;
      }
      tracker.recordEvent(progressEvent);
      if (progressEvent.type === "document") {
        activeGeneration = tracker.snapshot().generation;
      }
      refreshReport();
      return;
    }

    const value = event.data;
    if (typeof value !== "object" || value === null || Array.isArray(value) || !("type" in value)) return;
    const type = value.type;
    if (typeof type !== "string") return;
    workerOutputTypes[type] = (workerOutputTypes[type] ?? 0) + 1;

    if (type === "PATCH") {
      workerOutputEvents.patch += 1;
      tracker.recordWorkerOut(value as unknown as WorkerOut);
    } else if (type === "INITIALIZED") {
      if (lifecycle.workerInitializedAtMs !== null) {
        recordError("Received duplicate INITIALIZED output from the source worker.");
      } else {
        lifecycle.workerInitializedAtMs = elapsedMs();
      }
      initAcknowledgement?.(true);
      initAcknowledgement = null;
    } else if (type === "SOURCE_ADMITTED") {
      const generation = "generation" in value ? value.generation : undefined;
      if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 0) {
        recordError("Source worker SOURCE_ADMITTED omitted a valid native generation.", true);
      } else if (
        lifecycle.nativeAdmissionGeneration !== null &&
        lifecycle.nativeAdmissionGeneration !== generation
      ) {
        recordError(
          `Source worker admission generation changed from ${lifecycle.nativeAdmissionGeneration} to ${generation} without a source restart.`,
          true,
        );
      } else {
        lifecycle.nativeAdmissionGeneration = generation;
      }
    } else if (type === "FINALIZED") {
      if (lifecycle.workerFinalizedAtMs !== null) {
        recordError("Received duplicate FINALIZED output from the source worker.");
      } else {
        const generation = "generation" in value ? value.generation : undefined;
        lifecycle.workerFinalizedAtMs = elapsedMs();
        if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 0) {
          recordError("Source worker FINALIZED omitted a valid native generation.", true);
        } else {
          lifecycle.nativeFinalizedGeneration = generation;
          if (lifecycle.nativeAdmissionGeneration !== generation) {
            recordError(
              `FINALIZED generation ${generation} did not match admitted source generation ${String(lifecycle.nativeAdmissionGeneration)}.`,
              true,
            );
          }
        }
        clearFinalizationDeadline();
        void completeSemanticDrain();
      }
    } else if (type === "ERROR") {
      const message = "error" in value && typeof value.error === "object" && value.error !== null && "message" in value.error
        ? String(value.error.message)
        : "Worker emitted ERROR.";
      const phase = "phase" in value ? String(value.phase) : "unknown phase";
      recordError(`Source worker ERROR during ${phase}: ${message}`, true);
      if (lifecycle.workerInitializedAtMs === null) {
        initAcknowledgement?.(false);
        initAcknowledgement = null;
      }
    }
    refreshReport();
  });

  worker.addEventListener("error", (event: ErrorEvent) => {
    recordError(`Source module Worker error: ${event.message || "unknown Worker error"}`, true);
    initAcknowledgement?.(false);
    initAcknowledgement = null;
  });

  const originalPostMessage = worker.postMessage.bind(worker);
  worker.postMessage = (message: unknown, transferOrOptions?: Transferable[] | StructuredSerializeOptions): void => {
    const append = isAppendMessage(message) ? message.text : null;
    if (transferOrOptions === undefined) {
      originalPostMessage(message);
    } else if (Array.isArray(transferOrOptions)) {
      originalPostMessage(message, transferOrOptions);
    } else {
      originalPostMessage(message, transferOrOptions);
    }
    if (append !== null) observeDispatchedAppend(append);
  };
}

function hasPositiveShikiDecoration(line: HTMLElement): boolean {
  const spans = line.querySelectorAll("span[style]");
  const inspected = Math.min(spans.length, 256);
  for (let index = 0; index < inspected; index += 1) {
    const style = spans[index]?.getAttribute("style") ?? "";
    if (/(?:^|;)\s*--shiki-(?:dark|light)\s*:/.test(style)) return true;
  }
  return false;
}

function sampleVisibleSourceLines(): VisibilitySample | null {
  if (!codeFrame || !codeFrame.isConnected) {
    codeFrame = document.querySelector<HTMLDivElement>('div[data-code-block="true"]');
  }
  if (!codeFrame) return null;

  const frameRect = codeFrame.getBoundingClientRect();
  const visibleTop = Math.max(0, frameRect.top);
  const visibleBottom = Math.min(window.innerHeight, frameRect.bottom);
  const visibleLeft = Math.max(0, frameRect.left);
  const visibleRight = Math.min(window.innerWidth, frameRect.right);
  if (visibleBottom <= visibleTop || visibleRight <= visibleLeft) return null;

  const byLineNumber = new Map<number, VisibleLineSample>();
  let pointRows = 0;
  for (let y = Math.floor(visibleTop + 1); y < visibleBottom && pointRows < VIEWPORT_POINT_LIMIT; y += VIEWPORT_POINT_STEP_PX) {
    pointRows += 1;
    for (const offset of LINE_POINT_OFFSETS_PX) {
      const x = Math.min(visibleRight - 1, Math.max(visibleLeft + 1, frameRect.left + offset));
      const target = document.elementFromPoint(x, y);
      if (!(target instanceof HTMLElement)) continue;
      const line = target.closest<HTMLElement>(".line[data-line]");
      if (!line || !codeFrame.contains(line)) continue;

      const rect = line.getBoundingClientRect();
      const intersectsViewport = rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth;
      if (!intersectsViewport) continue;
      const lineNumber = Number(line.getAttribute("data-line"));
      if (!Number.isSafeInteger(lineNumber) || lineNumber < 1 || byLineNumber.has(lineNumber)) continue;

      const range = sourceLineRanges[lineNumber - 1];
      const visibleText = line.textContent ?? "";
      const exact = range?.lineNumber === lineNumber && range.text === visibleText;
      byLineNumber.set(lineNumber, {
        lineNumber,
        sourceRangeUTF16: exact && range ? { from: range.from, to: range.to } : null,
        sourceTextMatchesFixture: range ? exact : null,
        visibleTextUTF16Length: visibleText.length,
        viewportRect: {
          top: Number(rect.top.toFixed(2)),
          left: Number(rect.left.toFixed(2)),
          width: Number(rect.width.toFixed(2)),
          height: Number(rect.height.toFixed(2)),
        },
        shikiSpecificDecoration: hasPositiveShikiDecoration(line) ? "positive" : "unknown",
      });
      if (byLineNumber.size >= MAX_VISIBLE_LINES_PER_SAMPLE) break;
    }
    if (byLineNumber.size >= MAX_VISIBLE_LINES_PER_SAMPLE) break;
  }

  return { sampledAtMs: elapsedMs(), lines: [...byLineNumber.values()] };
}

function retainVisibilitySample(): void {
  const sample = sampleVisibleSourceLines();
  if (!sample) return;
  if (visibleSamples.length >= MAX_VISIBILITY_SAMPLES) {
    visibleSamples.shift();
    visibilitySamplesDropped += 1;
  }
  visibleSamples.push(sample);
  refreshReport();
}

function markAuthoredSourceEquality(): void {
  const authoredSource = authoredChunks.join("");
  const exact = authoredSource === fixture;
  report.authoredSourceEquality = {
    checked: true,
    exact,
    offeredUnitsUTF16: authoredSource.length,
    fixtureUnitsUTF16: fixture.length,
  };
  if (!exact) recordError("Concatenated authored source offered to the handle differs from the frozen fixture.");
}

function scheduleNextTraceOrdinal(): void {
  if (stopped) return;
  tickTimer = window.setTimeout(runTraceOrdinal, observation.scenario.updateIntervalMs);
}

function finishProducer(): void {
  lifecycle.producerCompletedAtMs = elapsedMs();
  markAuthoredSourceEquality();
  if (traceOrdinal !== trace.length) {
    ordinalChecks.offered = false;
    recordError(`Producer stopped after ${traceOrdinal} of ${trace.length} frozen trace ordinals.`);
  }
  if (!activeHandle) {
    recordError("StreamingMarkdown handle was unavailable when producer completed.", true);
    return;
  }

  try {
    const finalization = activeHandle.finalize();
    hostFinalization = finalization;
    lifecycle.finalizeRequestedAtMs = elapsedMs();
    armFinalizationDeadline("host FinalizeResult");
    void finalization.then(
      (result) => {
        lifecycle.hostFinalizationResult = result;
        if (!Number.isSafeInteger(result.generation) || result.generation < 0) {
          recordError("Host FinalizeResult omitted a valid native source generation.", true);
        }
        if (lifecycle.nativeAdmissionGeneration === null || result.generation !== lifecycle.nativeAdmissionGeneration) {
          recordError(
            `Host FinalizeResult generation ${result.generation} did not match admitted native generation ${String(lifecycle.nativeAdmissionGeneration)}.`,
            true,
          );
        }
        if (
          lifecycle.nativeFinalizedGeneration !== null &&
          result.generation !== lifecycle.nativeFinalizedGeneration
        ) {
          recordError(
            `Host FinalizeResult generation ${result.generation} did not match finalized native generation ${lifecycle.nativeFinalizedGeneration}.`,
            true,
          );
        }
        if (
          result.acceptedSourceUnits !== fixture.length ||
          result.committedSourceUnits !== fixture.length ||
          frontendCounters.accepted !== fixture.length
        ) {
          recordError(
            `Host FinalizeResult covered ${result.committedSourceUnits}/${result.acceptedSourceUnits} source units; expected ${fixture.length}.`,
            true,
          );
        }
        if (lifecycle.nativeFinalizedGeneration === null) {
          if (!stopped) armFinalizationDeadline("matching native FINALIZED acknowledgement");
        } else {
          clearFinalizationDeadline();
        }
        refreshReport();
      },
      (error: unknown) => {
        clearFinalizationDeadline();
        recordError(`StreamingMarkdownHandle.finalize rejected: ${error instanceof Error ? error.message : String(error)}`, true);
      },
    );
  } catch (error) {
    clearFinalizationDeadline();
    recordError(`StreamingMarkdownHandle.finalize failed: ${error instanceof Error ? error.message : String(error)}`, true);
    return;
  }
  setStatus("All frozen trace ordinals offered; waiting for the host FinalizeResult and matching native FINALIZED generation…");
  refreshReport();
}
async function pushThroughPublicHandle(text: string): Promise<void> {
  const expected = trace[ordinalCounters.accepted];
  if (!expected || expected.text !== text) {
    ordinalChecks.accepted = false;
    recordError(`Public handle append ordinal ${ordinalCounters.accepted} did not match the frozen campaign trace.`);
  }
  if (!activeHandle) {
    recordError("StreamingMarkdown handle was unavailable at the acceptance boundary.", true);
    return;
  }

  let admission: AppendResult;
  while (true) {
    try {
      admission = activeHandle.append(text);
      break;
    } catch (error) {
      if (!(error instanceof SourceCapacityError) || !error.retryable) throw error;
      await activeHandle.waitForCapacity({ units: text.length });
    }
  }
  const expectedAcceptedUnits = frontendCounters.accepted + text.length;
  if (admission.acceptedSourceUnits !== expectedAcceptedUnits) {
    recordError(
      `AppendResult accepted ${admission.acceptedSourceUnits} source units; expected ${expectedAcceptedUnits}.`,
      true,
    );
    return;
  }
  frontendCounters.accepted = admission.acceptedSourceUnits;
  ordinalCounters.accepted += 1;
  if (admission.shouldPause) {
    const nextChunk = trace[traceOrdinal];
    if (nextChunk) await activeHandle.waitForCapacity({ units: nextChunk.text.length });
  }
}

async function runTraceOrdinal(): Promise<void> {
  tickTimer = null;
  if (stopped) return;
  const chunk = trace[traceOrdinal];
  if (!chunk) {
    finishProducer();
    return;
  }

  const expectedAtMs = (traceOrdinal + 1) * observation.scenario.updateIntervalMs;
  if (chunk.atMs !== expectedAtMs) {
    ordinalChecks.offered = false;
    recordError(`Frozen trace ordinal ${traceOrdinal} has atMs=${chunk.atMs}; expected declared tick ${expectedAtMs}.`, true);
    return;
  }

  const actualAtMs = elapsedMs() - producerStartAt;
  producerTicks.push({
    ordinal: traceOrdinal,
    nominalAtMs: chunk.atMs,
    actualAtMs: Number(actualAtMs.toFixed(2)),
    latenessMs: Number(Math.max(0, actualAtMs - chunk.atMs).toFixed(2)),
  });
  authoredChunks.push(chunk.text);
  frontendCounters.offered += chunk.text.length;
  const expectedOffered = trace[ordinalCounters.offered];
  if (!expectedOffered || expectedOffered.text !== chunk.text) {
    ordinalChecks.offered = false;
    recordError(`Offered source ordinal ${ordinalCounters.offered} did not match the frozen campaign trace.`);
  }
  ordinalCounters.offered += 1;
  traceOrdinal += 1;

  try {
    await pushThroughPublicHandle(chunk.text);
  } catch (error) {
    recordError(`StreamingMarkdownHandle.append failed: ${error instanceof Error ? error.message : String(error)}`, true);
    refreshReport();
    return;
  }

  refreshReport();
  if (traceOrdinal === trace.length) {
    finishProducer();
  } else {
    scheduleNextTraceOrdinal();
  }
}

async function completeSemanticDrain(): Promise<void> {
  const handle = activeHandle;
  if (!handle) {
    recordError("Actual FINALIZED arrived without an attached public StreamingMarkdown handle.");
    return;
  }
  try {
    if (!hostFinalization) throw new Error("Actual FINALIZED arrived before host finalization was requested.");
    const timeout = Promise.withResolvers<never>();
    const semanticDrainTimer = window.setTimeout(() => {
      timeout.reject(new Error(`Host finalization and semantic drain timed out after ${HOST_FINALIZATION_TIMEOUT_MS}ms.`));
    }, HOST_FINALIZATION_TIMEOUT_MS);
    let finalizationValid = false;
    try {
      const result = await Promise.race([hostFinalization, timeout.promise]);
      lifecycle.hostFinalizationResult = result;
      finalizationValid =
        Number.isSafeInteger(result.generation) &&
        result.generation >= 0 &&
        lifecycle.nativeAdmissionGeneration !== null &&
        result.generation === lifecycle.nativeAdmissionGeneration &&
        lifecycle.nativeFinalizedGeneration !== null &&
        result.generation === lifecycle.nativeFinalizedGeneration &&
        result.acceptedSourceUnits === fixture.length &&
        result.committedSourceUnits === fixture.length &&
        frontendCounters.accepted === fixture.length;
      if (!finalizationValid) {
        recordError(
          `Host FinalizeResult generation/counts did not match admitted/finalized native generation ${String(lifecycle.nativeAdmissionGeneration)}/${String(lifecycle.nativeFinalizedGeneration)} and ${fixture.length} source units.`,
          true,
        );
      }
      await Promise.race([handle.waitForIdle(), timeout.promise]);
    } finally {
      window.clearTimeout(semanticDrainTimer);
    }
    const rendererState = handle.getState();
    if (rendererState.queueDepth !== 0 || rendererState.pendingBatches !== 0) {
      recordError(
        `Renderer queue remained at depth ${rendererState.queueDepth} with ${rendererState.pendingBatches} pending batches after waitForIdle.`,
        true,
      );
    }
    const progress = tracker.snapshot();
    const frontiersComplete =
      progress.engineEnteredUTF16Frontier === fixture.length &&
      progress.parsedUTF16Frontier === fixture.length &&
      progress.fullySemanticAppliedUTF16Frontier === fixture.length;
    const ordinalsComplete =
      ordinalCounters.offered === trace.length &&
      ordinalCounters.accepted === trace.length &&
      ordinalCounters.dispatched === trace.length &&
      ordinalChecks.offered &&
      ordinalChecks.accepted &&
      ordinalChecks.dispatched;
    if (progress.engineEnteredUTF16Frontier !== fixture.length) {
      recordError(`Missing engine-entered frontier: observed ${progress.engineEnteredUTF16Frontier} of ${fixture.length} UTF-16 units.`);
    }
    if (progress.parsedUTF16Frontier !== fixture.length) {
      recordError(`Missing parsed frontier: observed ${progress.parsedUTF16Frontier} of ${fixture.length} UTF-16 units.`);
    }
    if (progress.fullySemanticAppliedUTF16Frontier !== fixture.length) {
      recordError(`Missing fully-semantic-applied frontier: observed ${progress.fullySemanticAppliedUTF16Frontier} of ${fixture.length} UTF-16 units.`);
    }
    if (traceEventCounts.document !== 1) recordError(`Expected one document trace event; observed ${traceEventCounts.document}.`);
    if (traceEventCounts.engineEntered !== trace.length) {
      recordError(`Missing engine-entered trace events: observed ${traceEventCounts.engineEntered} for ${trace.length} APPEND ordinals.`);
    }
    if (traceEventCounts.parsedPublication === 0) recordError("No parsed-publication trace event was observed.");
    if (progress.incomplete) {
      for (const error of progress.errors) {
        recordError(`Publication tracker ${error.code}${error.tx === undefined ? "" : ` tx=${error.tx}`}${error.publicationId === undefined ? "" : ` publication=${error.publicationId}`}${error.ordinal === undefined ? "" : ` ordinal=${error.ordinal}`}.`);
      }
      recordError("Publication progress tracker reports incomplete semantic application.");
    }
    if (lifecycle.workerFinalizedAtMs === null) recordError("Semantic drain completed without an actual worker FINALIZED message.");
    if (report.authoredSourceEquality.exact !== true) recordError("Authored source equality was not proven exact.");
    if (!report.traceConsumption.complete) recordError("Frozen trace ordinal consumption is incomplete or diverged.");

    lifecycle.semanticDrainComplete =
      finalizationValid && frontiersComplete && ordinalsComplete && !progress.incomplete && errors.length === 0;
    retainVisibilitySample();
    if (visibilityTimer !== null) {
      window.clearInterval(visibilityTimer);
      visibilityTimer = null;
    }
    report.status = lifecycle.semanticDrainComplete ? "complete" : "error";
    if (report.status === "complete") {
      setStatus(
        `Complete: native generation ${lifecycle.nativeFinalizedGeneration} matched host FinalizeResult ${lifecycle.hostFinalizationResult?.generation}; semantic patch drain observed.`,
      );
    } else {
      setStatus("Observation finished with incomplete or invalid progress evidence.");
    }
    removeFlushListener?.();
    removeFlushListener = null;
    refreshReport();
  } catch (error) {
    recordError(`Host finalization or semantic drain failed: ${error instanceof Error ? error.message : String(error)}`, true);
  }
}

async function initializeObservation(worker: Worker): Promise<void> {
  const readyHandleSignal = Promise.withResolvers<StreamingMarkdownHandle>();
  let readyTimer: number | undefined;
  let readyFrame: number | undefined;
  let readySettled = false;
  readyTimer = window.setTimeout(() => {
    if (readySettled) return;
    readySettled = true;
    readyHandleSignal.reject(
      new Error(`StreamingMarkdown handle did not become worker-ready within ${HOST_FINALIZATION_TIMEOUT_MS}ms.`),
    );
  }, HOST_FINALIZATION_TIMEOUT_MS);
  const waitForHandle = () => {
    if (readySettled) return;
    const handle = handleRef.current;
    if (handle?.getState().workerReady) {
      readySettled = true;
      readyHandleSignal.resolve(handle);
    } else {
      readyFrame = window.requestAnimationFrame(waitForHandle);
    }
  };
  let readyHandle: StreamingMarkdownHandle;
  try {
    waitForHandle();
    readyHandle = await readyHandleSignal.promise;
  } finally {
    if (readyTimer !== undefined) window.clearTimeout(readyTimer);
    if (readyFrame !== undefined) window.cancelAnimationFrame(readyFrame);
  }
  activeHandle = readyHandle;
  lifecycle.rendererWorkerReadyAtMs = elapsedMs();
  removeFlushListener = readyHandle.onFlush((result) => {
    workerOutputEvents.flush += 1;
    if (activeGeneration === null) {
      recordError("PatchFlushResult arrived before a document trace generation; flush was not credited.");
    } else {
      tracker.recordPatchFlushResult(activeGeneration, result);
    }
    refreshReport();
  });

  const initialization = Promise.withResolvers<boolean>();
  let initializationTimedOut = false;
  const initializationTimer = window.setTimeout(() => {
    initializationTimedOut = true;
    initAcknowledgement?.(false);
    initAcknowledgement = null;
  }, HOST_FINALIZATION_TIMEOUT_MS);
  initAcknowledgement = (success) => {
    window.clearTimeout(initializationTimer);
    initAcknowledgement = null;
    initialization.resolve(success);
  };
  const initMessage: WorkerIn = { type: "INIT", schemaVersion: STREAM_MDX_SCHEMA_VERSION, initialContent: "",
  prewarmLangs: [],
  docPlugins: {
    footnotes: true,
    html: true,
    mdx: false,
    tables: true,
    callouts: false,
    math: true,
    formatAnticipation: featurePolicy.formatAnticipation,
    codeHighlighting: "incremental",
    liveCodeHighlighting: true,
    emitDiffBlocks: false,
  },
  mdx: { compileMode: "server" }, };
  worker.postMessage(initMessage);
  const initializedSuccessfully = await initialization.promise;
  if (!initializedSuccessfully || stopped) {
    recordError(
      initializationTimedOut
        ? `Source worker INITIALIZED acknowledgement timed out after ${HOST_FINALIZATION_TIMEOUT_MS}ms.`
        : "Source worker did not return a successful INITIALIZED message.",
      true,
    );
    return;
  }
  if (activeGeneration === null) recordError("Source worker initialized without the required document-generation trace event.");

  report.status = "ready";
  progressWindow.__streamMdxProgressObservationReady = true;
  refreshReport();
  setStatus("Source worker initialized; beginning the frozen 20ms campaign trace.");
  lifecycle.producerStartedAtMs = elapsedMs();
  producerStartAt = lifecycle.producerStartedAtMs;
  report.status = "running";
  visibilityTimer = window.setInterval(retainVisibilitySample, VISIBILITY_SAMPLE_INTERVAL_MS);
  scheduleNextTraceOrdinal();
}

progressWindow.__streamMdxProgressObservationReady = false;
progressWindow.__streamMdxProgressObservationReport = report;

if (!root) {
  recordError("The static observation page is missing its output mount.", true);
} else {
  const workerUrl = new URL("./worker.js", window.location.href);
  const worker = new Worker(workerUrl, { type: "module", name: "stream-mdx-progress-observation" });
  report.identity.worker = {
    url: workerUrl.href,
    moduleWorker: worker instanceof Worker,
    constructorName: worker.constructor.name,
  };
  installWorkerInstrumentation(worker);
  root.render(
    createElement(StreamingMarkdown, {
      ref: handleRef,
      worker,
      engine: "worker",
      managedWorker: true,
      features: featurePolicy,
      scheduling,
      caret: false,
      className: "markdown-v2-output",
      onError(error) {
        recordError(`StreamingMarkdown onError: ${error.message}`, true);
        initAcknowledgement?.(false);
        initAcknowledgement = null;
      },
    }),
  );

  void (async () => {
    try {
      report.identity.computedFixtureSha256 = await sha256(fixture);
      report.identity.computedTraceSha256 = await sha256(JSON.stringify(trace));
      if (report.identity.computedFixtureSha256 !== observation.fixtureHash) {
        recordError("Generated fixture SHA-256 differs from the frozen campaign identity.", true);
        return;
      }
      if (report.identity.computedTraceSha256 !== observation.traceHash || trace.length !== observation.chunkCount) {
        recordError("Generated trace SHA-256 or ordinal count differs from the frozen campaign identity.", true);
        return;
      }
      if (fixture.length !== observation.targetUnits || !fixture.includes(observation.expectedAuthoredSnippet)) {
        recordError("Generated fixture length or authored code snippet differs from the frozen campaign identity.", true);
        return;
      }
      refreshReport();
      await initializeObservation(worker);
    } catch (error) {
      recordError(`Observation setup failed: ${error instanceof Error ? error.message : String(error)}`, true);
    }
  })();
}
