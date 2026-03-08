import { applyPatchBatch, createInitialSnapshot, type Block, type DocumentSnapshot, type Patch, type PatchMetrics } from "@stream-mdx/core";
import type {
  StreamMdxDoneEventV1,
  StreamMdxErrorEventV1,
  StreamMdxEventV1,
  StreamMdxInitEventV1,
  StreamMdxMetricsEventV1,
  StreamMdxPatchEventV1,
  StreamMdxSnapshotEventV1,
} from "@stream-mdx/protocol";

export type StreamMdxStoreMeta = {
  init?: StreamMdxInitEventV1;
  lastTx?: number;
  metrics?: PatchMetrics;
  error?: StreamMdxErrorEventV1;
  done?: StreamMdxDoneEventV1;
};

export type StreamMdxSnapshotStore = {
  getSnapshot(): DocumentSnapshot;
  getBlocks(): Block[];
  getMeta(): StreamMdxStoreMeta;
  setSnapshot(blocks: Block[]): Block[];
  applyPatches(patches: Patch[]): Block[];
  applyEvent(event: StreamMdxEventV1): Block[];
  applyEvents(events: StreamMdxEventV1[]): Block[];
};

export function createSnapshotStore(initialBlocks: Block[] = []): StreamMdxSnapshotStore {
  let snapshot = createInitialSnapshot(initialBlocks);
  const meta: StreamMdxStoreMeta = {};

  const setSnapshot = (blocks: Block[]): Block[] => {
    snapshot = createInitialSnapshot(blocks ?? []);
    return snapshot.blocks;
  };

  const applyPatches = (patches: Patch[]): Block[] => {
    return applyPatchBatch(snapshot, patches ?? []);
  };

  const applyEvent = (event: StreamMdxEventV1): Block[] => {
    if (!event || typeof event !== "object") {
      return snapshot.blocks;
    }
    switch (event.event) {
      case "init":
        meta.init = event as StreamMdxInitEventV1;
        return snapshot.blocks;
      case "snapshot":
        return setSnapshot((event as StreamMdxSnapshotEventV1).blocks ?? []);
      case "patch": {
        const patchEvent = event as StreamMdxPatchEventV1;
        if (typeof patchEvent.tx === "number") {
          meta.lastTx = patchEvent.tx;
        }
        return applyPatches(patchEvent.patches ?? []);
      }
      case "metrics":
        meta.metrics = (event as StreamMdxMetricsEventV1).metrics;
        return snapshot.blocks;
      case "error":
        meta.error = event as StreamMdxErrorEventV1;
        return snapshot.blocks;
      case "done":
        meta.done = event as StreamMdxDoneEventV1;
        return snapshot.blocks;
      default:
        return snapshot.blocks;
    }
  };

  const applyEvents = (events: StreamMdxEventV1[]): Block[] => {
    let blocks = snapshot.blocks;
    for (const event of events) {
      blocks = applyEvent(event);
    }
    return blocks;
  };

  return {
    getSnapshot: () => snapshot,
    getBlocks: () => snapshot.blocks,
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

export function decodeNdjson<T = StreamMdxEventV1>(input: string): T[] {
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

export class NdjsonDecoder<T = StreamMdxEventV1> {
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
