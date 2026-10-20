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

const snapshotFrom = (input: Block[] | NodeSnapshot): DocumentSnapshot =>
  Array.isArray(input) ? createInitialSnapshot(input) : createInitialSnapshot(input);

export function createSnapshotStore(initial: Block[] | NodeSnapshot = []): StreamMdxSnapshotStore {
  let snapshot = snapshotFrom(initial);
  const meta: StreamMdxStoreMeta = {};

  const setSnapshot = (input: Block[] | NodeSnapshot): void => {
    snapshot = snapshotFrom(input);
  };

  const applyPatches = (patches: Patch[]): void => {
    applyPatchBatch(snapshot, patches);
  };

  const applyEvent = (event: StreamMdxEvent): void => {
    if (event.protocol !== STREAM_MDX_PROTOCOL_ID || event.schemaVersion !== STREAM_MDX_SCHEMA_VERSION) {
      throw new Error(`Unsupported stream-mdx wire identity: ${event.protocol}/${event.schemaVersion}`);
    }
    switch (event.event) {
      case "init":
        meta.init = event;
        break;
      case "snapshot":
        setSnapshot(event.snapshot);
        break;
      case "patch":
        applyPatches(event.patches);
        meta.lastTx = event.tx;
        break;
      case "metrics":
        meta.metrics = event.metrics;
        break;
      case "error":
        meta.error = event;
        break;
      case "done":
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
