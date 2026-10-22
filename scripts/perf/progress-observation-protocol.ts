import type { ProgressObservationEvent } from "./progress-observation";

export const PROGRESS_OBSERVATION_TRACE_MARKER = "__streamMdxProgressObservationTrace" as const;

export interface ProgressObservationTraceMessage {
  readonly [PROGRESS_OBSERVATION_TRACE_MARKER]: true;
  readonly event: ProgressObservationEvent;
}

export type ReadProgressObservationTrace =
  | { readonly marked: false }
  | { readonly marked: true; readonly event: ProgressObservationEvent | null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readProgressObservationTrace(value: unknown): ReadProgressObservationTrace {
  if (!isRecord(value) || value[PROGRESS_OBSERVATION_TRACE_MARKER] !== true) {
    return { marked: false };
  }

  const candidate = value.event;
  if (!isRecord(candidate) || typeof candidate.type !== "string") {
    return { marked: true, event: null };
  }

  if (candidate.type === "document" && typeof candidate.generation === "number") {
    return { marked: true, event: candidate as unknown as ProgressObservationEvent };
  }
  if (
    candidate.type === "engine-entered" &&
    typeof candidate.generation === "number" &&
    typeof candidate.sourceUnits === "number"
  ) {
    return { marked: true, event: candidate as unknown as ProgressObservationEvent };
  }
  if (candidate.type === "parsed-publication" && isRecord(candidate.publication)) {
    const publication = candidate.publication;
    if (
      typeof publication.generation === "number" &&
      typeof publication.publicationId === "number" &&
      typeof publication.sourceUnits === "number" &&
      typeof publication.semanticPatchCount === "number"
    ) {
      return { marked: true, event: candidate as unknown as ProgressObservationEvent };
    }
  }

  return { marked: true, event: null };
}
