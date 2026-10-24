export type AppendResult = {
  /** Total UTF-16 source units accepted by append calls in this session. */
  acceptedSourceUnits: number;
  /** Accepted append units not yet acknowledged by the worker. */
  pendingSourceUnits: number;
  /** Whether the soft admission threshold has been reached. */
  shouldPause: boolean;
};
export type FinalizeResult = {
  /** Native worker document generation that finalized this host session. */
  generation: number;
  /** Total UTF-16 source units accepted by append calls in this session. */
  acceptedSourceUnits: number;
  /** Accepted source units whose semantic patches have committed to the renderer store. */
  committedSourceUnits: number;
};

export type WaitForCapacityOptions = {
  /** UTF-16 source units the next append needs to admit. */
  units: number;
  signal?: AbortSignal;
};

export type StreamSessionErrorReason = "sealed" | "stale-generation" | "disposed";

export class SourceCapacityError extends Error {
  readonly offeredSourceUnits: number;
  readonly pendingSourceUnits: number;
  readonly hardLimitSourceUnits: number;
  readonly retryable: boolean;

  constructor(offeredSourceUnits: number, pendingSourceUnits: number, hardLimitSourceUnits: number) {
    super(
      `Appending ${offeredSourceUnits} UTF-16 source units would exceed the ${hardLimitSourceUnits}-unit admission limit (${pendingSourceUnits} units are pending)`,
    );
    this.name = "SourceCapacityError";
    this.offeredSourceUnits = offeredSourceUnits;
    this.pendingSourceUnits = pendingSourceUnits;
    this.hardLimitSourceUnits = hardLimitSourceUnits;
    this.retryable = offeredSourceUnits <= hardLimitSourceUnits;
  }
}

export class StreamSessionError extends Error {
  readonly reason: StreamSessionErrorReason;

  constructor(reason: StreamSessionErrorReason, message: string) {
    super(message);
    this.name = "StreamSessionError";
    this.reason = reason;
  }
}
