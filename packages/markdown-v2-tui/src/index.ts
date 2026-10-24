import { applyPatchBatch, createInitialSnapshot, type Block, type DocumentSnapshot, type NodeSnapshot, type Patch, type PatchMetrics } from "@stream-mdx/core";
import { STREAM_MDX_PROTOCOL_ID, STREAM_MDX_SCHEMA_VERSION } from "@stream-mdx/protocol";
import type { StreamMdxDoneEvent, StreamMdxErrorEvent, StreamMdxEvent, StreamMdxInitEvent } from "@stream-mdx/protocol";

export type StreamMdxStoreMeta = {
  init?: StreamMdxInitEvent;
  lastTx?: number;
  metrics?: PatchMetrics;
  error?: StreamMdxErrorEvent;
  done?: StreamMdxDoneEvent;
};

export type StreamMdxSnapshotStore = {
  getSnapshot(): DocumentSnapshot;
  getBlocks(): Block[];
  getMeta(): StreamMdxStoreMeta;
  setSnapshot(input: Block[] | NodeSnapshot): void;
  applyPatches(patches: Patch[]): void;
  applyEvent(event: StreamMdxEvent): void;
  applyEvents(events: StreamMdxEvent[]): void;
};

function nativeGenerationFrom(input: Block[] | NodeSnapshot): number | null {
  return !Array.isArray(input) && input.inputSource ? input.inputSource.generation : null;
}

function clearGenerationMetadata(meta: StreamMdxStoreMeta): void {
  delete meta.lastTx;
  delete meta.metrics;
  delete meta.error;
  delete meta.done;
}

export function createSnapshotStore(initial: Block[] | NodeSnapshot = []): StreamMdxSnapshotStore {
  let snapshot = Array.isArray(initial) ? createInitialSnapshot(initial) : createInitialSnapshot(initial);
  let sourceGeneration = nativeGenerationFrom(initial);
  let generationFloor = sourceGeneration;
  let retiredNativeGeneration: number | null = null;
  let streamId: string | null = null;
  const meta: StreamMdxStoreMeta = {};

  const isAdmissibleNativeGeneration = (generation: number): boolean =>
    (generationFloor === null || generation >= generationFloor)
    && (retiredNativeGeneration === null || generation > retiredNativeGeneration);

  const replaceSnapshot = (
    input: Block[] | NodeSnapshot,
    nextGeneration = nativeGenerationFrom(input),
  ): boolean => {
    if (nextGeneration !== null && !isAdmissibleNativeGeneration(nextGeneration)) return false;
    const nextSnapshot = Array.isArray(input) ? createInitialSnapshot(input) : createInitialSnapshot(input);
    if (nextGeneration === null) {
      if (sourceGeneration !== null &&
        (retiredNativeGeneration === null || sourceGeneration > retiredNativeGeneration)) {
        retiredNativeGeneration = sourceGeneration;
      }
      sourceGeneration = null;
      clearGenerationMetadata(meta);
    } else {
      if (sourceGeneration !== nextGeneration) clearGenerationMetadata(meta);
      sourceGeneration = nextGeneration;
      if (generationFloor === null || nextGeneration > generationFloor) generationFloor = nextGeneration;
    }
    snapshot = nextSnapshot;
    return true;
  };

  const setSnapshot = (input: Block[] | NodeSnapshot): void => {
    replaceSnapshot(input);
  };

  const applyPatches = (patches: Patch[]): void => {
    applyPatchBatch(snapshot, patches);
  };
  const isAdmissibleEvent = (event: StreamMdxEvent): boolean => {
    if (!Number.isSafeInteger(event.generation) || event.generation < 0) {
      throw new Error("Incompatible stream-mdx event: native generation is missing or invalid");
    }
    if (typeof event.streamId !== "string") {
      throw new Error("Incompatible stream-mdx event: stream ID is missing or invalid");
    }
    return (streamId === null || event.streamId === streamId)
      && isAdmissibleNativeGeneration(event.generation);
  };

  const acceptStream = (event: StreamMdxEvent): void => {
    if (streamId === null) streamId = event.streamId;
  };

  const applyEvent = (event: StreamMdxEvent): void => {
    if (event.protocol !== STREAM_MDX_PROTOCOL_ID || event.schemaVersion !== STREAM_MDX_SCHEMA_VERSION) {
      throw new Error(`Unsupported stream-mdx wire identity: ${event.protocol}/${event.schemaVersion}`);
    }
    if (!isAdmissibleEvent(event)) return;
    switch (event.event) {
      case "init":
        if (generationFloor === null || event.generation > generationFloor) {
          clearGenerationMetadata(meta);
          generationFloor = event.generation;
        }
        acceptStream(event);
        meta.init = event;
        break;
      case "snapshot": {
        const nativeGeneration = nativeGenerationFrom(event.snapshot);
        if (nativeGeneration === null) {
          throw new Error("Incompatible stream-mdx snapshot: canonical input baseline is missing or invalid");
        }
        if (nativeGeneration !== event.generation) return;
        if (!replaceSnapshot(event.snapshot, nativeGeneration)) return;
        acceptStream(event);
        break;
      }
      case "patch":
        if (event.generation !== sourceGeneration) return;
        acceptStream(event);
        applyPatches(event.patches);
        meta.lastTx = event.tx;
        break;
      case "metrics":
        if (event.generation !== sourceGeneration) return;
        acceptStream(event);
        meta.metrics = event.metrics;
        break;
      case "error":
        if (event.generation !== sourceGeneration) return;
        acceptStream(event);
        meta.error = event;
        break;
      case "done":
        if (event.generation !== sourceGeneration) return;
        acceptStream(event);
        meta.done = event;
        break;
    }
  };

  const applyEvents = (events: StreamMdxEvent[]): void => {
    for (const event of events) applyEvent(event);
  };

  return {
    getSnapshot: () => snapshot,
    getBlocks: () => snapshot.getBlocks(),
    getMeta: () => ({ ...meta }),
    setSnapshot,
    applyPatches,
    applyEvent,
    applyEvents,
  };
}

export function encodeNdjsonEvent<T>(event: T): string {
  return `${JSON.stringify(event)}\n`;
}

export function encodeNdjsonEvents<T>(events: Iterable<T>): string {
  let output = "";
  for (const event of events) {
    output += encodeNdjsonEvent(event);
  }
  return output;
}

export function decodeNdjson<T = StreamMdxEvent>(input: string): T[] {
  if (!input) return [];
  const lines = input.split(/\r?\n/);
  const result: T[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    result.push(JSON.parse(trimmed) as T);
  }
  return result;
}

export class NdjsonDecoder<T = StreamMdxEvent> {
  private buffer = "";
  private decoder: TextDecoder | null;

  constructor() {
    this.decoder = typeof TextDecoder !== "undefined" ? new TextDecoder() : null;
  }

  reset(): void {
    this.buffer = "";
  }

  push(chunk: string | Uint8Array): T[] {
    if (typeof chunk === "string") {
      this.buffer += chunk;
    } else if (chunk && chunk.length > 0) {
      this.buffer += this.decodeBytes(chunk);
    }
    return this.drain(false);
  }

  flush(): T[] {
    if (this.decoder) {
      this.buffer += this.decoder.decode();
    }
    return this.drain(true);
  }

  private decodeBytes(chunk: Uint8Array): string {
    if (this.decoder) {
      return this.decoder.decode(chunk, { stream: true });
    }
    if (typeof Buffer !== "undefined") {
      return Buffer.from(chunk).toString("utf8");
    }
    let result = "";
    for (const byte of chunk) {
      result += String.fromCharCode(byte);
    }
    return result;
  }

  private drain(flush: boolean): T[] {
    const lines = this.buffer.split(/\r?\n/);
    const tail = lines.pop() ?? "";
    this.buffer = flush ? "" : tail;
    const result: T[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      result.push(JSON.parse(trimmed) as T);
    }
    if (flush) {
      const trimmed = tail.trim();
      if (trimmed.length > 0) {
        result.push(JSON.parse(trimmed) as T);
      }
    }
    return result;
  }
}
