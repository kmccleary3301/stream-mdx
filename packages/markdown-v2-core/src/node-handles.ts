import type { CodeLineRecord } from "./code-records";
import type { CodeBlockSourceMetadata } from "./types";

const codeNodeHandleBrand: unique symbol = Symbol("CodeNodeHandle");

/** Zero-based, half-open line range. Reads clamp both bounds to the current line count. */
export interface CodeLineRange {
  readonly from: number;
  readonly to: number;
}

/** Bounded code-owner metadata; line records remain available through explicit range reads. */
export interface CodeBlockMetadata extends CodeBlockSourceMetadata {
  readonly configurationRevision: number;
  readonly info: string;
  readonly language?: string;
}

/** Opaque, owner-local read and observation access to prepared code state. */
export interface CodeNodeHandle {
  readonly [codeNodeHandleBrand]: true;
  readonly readSource: () => string;
  /** Stable bounded metadata, replaced when the owner source frontier or lifecycle changes. */
  readonly readMetadata: () => CodeBlockMetadata;
  /** Reads a bounded half-open range; retained snapshots preserve identity until invalidated or evicted. */
  readonly readLines: (range: CodeLineRange) => readonly CodeLineRecord[];
  /** Unsubscribe releases only this metadata listener, not the owner. */
  readonly subscribeMetadata: (listener: () => void) => () => void;
  /** Notifies when changed records intersect the range; unsubscribe releases only this listener. */
  readonly subscribeLines: (range: CodeLineRange, listener: () => void) => () => void;
}

/** Create the branded read-only handle implemented by a code owner adapter. */
export function createCodeNodeHandle(
  operations: Omit<CodeNodeHandle, typeof codeNodeHandleBrand>,
): CodeNodeHandle {
  const handle: CodeNodeHandle = { ...operations, [codeNodeHandleBrand]: true };
  return Object.freeze(handle);
}
