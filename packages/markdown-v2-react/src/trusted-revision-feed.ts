import type { Block } from "@stream-mdx/core";
import type { TrustedMdxRevision } from "./trusted-mdx-contract";

export interface TrustedRevisionFeedSnapshot {
  readonly generation: number;
  readonly version: number;
  readonly generationCause: "initial" | "replacement" | "reset";
  /** Full controlled text input while its worker generation is still being prepared. */
  readonly pendingSource: string | null;
  readonly revision: TrustedMdxRevision | null;
}

export interface TrustedRevisionToken {
  readonly generation: number;
  readonly version: number;
}

const revisionFeeds = new WeakMap<object, TrustedRevisionFeed>();

/** Holds accepted authored chunks until a correlated worker FINALIZED acknowledgement. */
export class TrustedRevisionFeed {
  private generation = 1;
  private generationCause: TrustedRevisionFeedSnapshot["generationCause"] = "initial";
  private pendingSource: string | null = null;
  private version = 0;
  private chunks: string[] = [];
  private completedVersion = -1;
  private inputSealed = false;
  private currentSnapshot: TrustedRevisionFeedSnapshot = Object.freeze({
    generation: 1,
    version: 0,
    generationCause: "initial",
    pendingSource: null,
    revision: null,
  });
  private readonly listeners = new Set<() => void>();

  readonly getSnapshot = (): TrustedRevisionFeedSnapshot => this.currentSnapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  replace(source: string): number {
    this.pendingSource = source;
    this.generationCause = "replacement";
    this.generation += 1;
    this.version = 0;
    this.chunks = source.length > 0 ? [source] : [];
    this.completedVersion = -1;
    this.inputSealed = false;
    this.publish(null);
    return this.generation;
  }

  reset(): number {
    this.pendingSource = null;
    this.generationCause = "reset";
    this.generation += 1;
    this.version = 0;
    this.chunks = [];
    this.completedVersion = -1;
    this.inputSealed = false;
    this.publish(null);
    return this.generation;
  }

  append(chunk: string): void {
    if (this.inputSealed) throw new Error("Cannot append trusted source after FINALIZE; start a new generation first.");
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.version += 1;
    if (this.pendingSource !== null) {
      this.pendingSource = null;
      this.publish(null);
    }
  }

  requestFinalization(): TrustedRevisionToken {
    this.inputSealed = true;
    return { generation: this.generation, version: this.version };
  }

  isCurrent(token: TrustedRevisionToken): boolean {
    return token.generation === this.generation && token.version === this.version;
  }

  complete(token: TrustedRevisionToken, blocks: readonly Block[]): boolean {
    if (!this.isCurrent(token) || this.completedVersion === token.version) return false;


    const stableBlocks = Object.freeze(blocks.map((block) => Object.freeze({
      ...block,
      payload: Object.freeze({
        ...block.payload,
        range: block.payload.range ? Object.freeze({ ...block.payload.range }) : undefined,
        meta: block.payload.meta ? Object.freeze({ ...block.payload.meta }) : undefined,
      }),
    })));
    const revision: TrustedMdxRevision = Object.freeze({
      source: this.chunks.join(""),
      blocks: stableBlocks,
    });

    this.completedVersion = token.version;
    this.pendingSource = null;
    this.publish(revision);
    return true;
  }

  private publish(revision: TrustedMdxRevision | null): void {
    this.currentSnapshot = Object.freeze({
      generation: this.generation,
      version: this.version,
      generationCause: this.generationCause,
      pendingSource: this.pendingSource,
      revision,
    });
    for (const listener of this.listeners) listener();
  }
}

export function attachTrustedRevisionFeed(owner: object): TrustedRevisionFeed {
  const feed = new TrustedRevisionFeed();
  revisionFeeds.set(owner, feed);
  return feed;
}

export function getTrustedRevisionFeed(owner: object): TrustedRevisionFeed | null {
  return revisionFeeds.get(owner) ?? null;
}
