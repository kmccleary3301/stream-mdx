import { getPatchKind } from "@stream-mdx/core/perf/patch-batching";
import type { Patch, WorkerOut } from "@stream-mdx/core";
import type { PatchFlushResult } from "../../packages/markdown-v2-react/src/renderer/patch-commit-scheduler";

export interface Publication {
  readonly generation: number;
  readonly publicationId: number;
  readonly sourceUnits: number;
  readonly semanticPatchCount: number;
}

export interface DiagnosticPatchTag {
  readonly generation: number;
  readonly publicationId: number;
  readonly ordinal: number;
}

export const PRIVATE_DIAGNOSTIC_PATCH_TAG_KEY = "__streamMdxDiagnosticPatchTag" as const;

export type ProgressObservationEvent =
  | { readonly type: "document"; readonly generation: number }
  | { readonly type: "engine-entered"; readonly generation: number; readonly sourceUnits: number }
  | { readonly type: "parsed-publication"; readonly publication: Publication };

export interface PublicationProgressError {
  readonly code:
    | "invalid-generation"
    | "duplicate-generation"
    | "stale-generation"
    | "invalid-engine-frontier"
    | "invalid-publication"
    | "duplicate-publication"
    | "publication-frontier-regressed"
    | "invalid-worker-message"
    | "duplicate-transaction"
    | "missing-diagnostic-tag"
    | "invalid-diagnostic-tag"
    | "duplicate-diagnostic-tag"
    | "unexpected-diagnostic-tag"
    | "invalid-flush-result"
    | "missing-flush-transaction"
    | "overcounted-flush"
    | "missing-publication-descriptor"
    | "missing-publication-ordinal"
    | "unconsumed-semantic-patches";
  readonly generation?: number;
  readonly publicationId?: number;
  readonly ordinal?: number;
  readonly tx?: number;
  readonly expected?: number;
  readonly observed?: number;
}

export interface PublicationProgressSnapshot {
  readonly generation: number | null;
  readonly engineEnteredUTF16Frontier: number;
  readonly parsedUTF16Frontier: number;
  readonly fullySemanticAppliedUTF16Frontier: number;
  readonly incomplete: boolean;
  readonly errors: readonly PublicationProgressError[];
}

interface PublicationState {
  descriptor?: Publication;
  readonly tagTransactions: Map<number, number>;
  invalid: boolean;
}

interface TransactionState {
  received: boolean;
  semanticPatchCount?: number;
  readonly tags: DiagnosticPatchTag[];
  flushSemanticPatchCount: number;
  invalid: boolean;
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function readDiagnosticPatchTag(patch: Patch): DiagnosticPatchTag | undefined {
  const candidate = (patch as Patch & Record<string, unknown>)[PRIVATE_DIAGNOSTIC_PATCH_TAG_KEY];
  if (candidate === undefined) return undefined;
  if (!candidate || typeof candidate !== "object") return { generation: Number.NaN, publicationId: Number.NaN, ordinal: Number.NaN };
  const tag = candidate as Partial<DiagnosticPatchTag>;
  if (
    !Number.isSafeInteger(tag.generation) ||
    !Number.isSafeInteger(tag.publicationId) ||
    !Number.isSafeInteger(tag.ordinal)
  ) {
    return { generation: Number.NaN, publicationId: Number.NaN, ordinal: Number.NaN };
  }
  return {
    generation: tag.generation as number,
    publicationId: tag.publicationId as number,
    ordinal: tag.ordinal as number,
  };
}

function errorKey(error: PublicationProgressError): string {
  return [
    error.code,
    error.generation ?? "",
    error.publicationId ?? "",
    error.ordinal ?? "",
    error.tx ?? "",
    error.expected ?? "",
    error.observed ?? "",
  ].join(":");
}

export class PublicationProgressTracker {
  private activeGeneration: number | null = null;
  private engineEnteredUTF16Frontier = 0;
  private parsedUTF16Frontier = 0;
  private readonly publications = new Map<number, PublicationState>();
  private readonly transactions = new Map<number, TransactionState>();
  private readonly errors = new Map<string, PublicationProgressError>();

  resetGeneration(generation: number): void {
    if (!Number.isSafeInteger(generation) || generation < 0) {
      this.addError({ code: "invalid-generation", generation });
      return;
    }
    if (this.activeGeneration !== null && generation === this.activeGeneration) {
      this.addError({ code: "duplicate-generation", generation });
      return;
    }
    if (this.activeGeneration !== null && generation < this.activeGeneration) {
      this.addError({ code: "stale-generation", generation });
      return;
    }
    this.activeGeneration = generation;
    this.engineEnteredUTF16Frontier = 0;
    this.parsedUTF16Frontier = 0;
    this.publications.clear();
    this.transactions.clear();
    this.errors.clear();
  }

  recordEvent(event: ProgressObservationEvent): void {
    switch (event.type) {
      case "document":
        this.resetGeneration(event.generation);
        return;
      case "engine-entered":
        this.recordEngineEntered(event.generation, event.sourceUnits);
        return;
      case "parsed-publication":
        this.recordPublication(event.publication);
        return;
    }
  }

  recordEngineEntered(generation: number, sourceUnits: number): void {
    if (!this.acceptGeneration(generation)) return;
    if (!isNonNegativeInteger(sourceUnits)) {
      this.addError({ code: "invalid-engine-frontier", generation, observed: sourceUnits });
      return;
    }
    this.engineEnteredUTF16Frontier = Math.max(this.engineEnteredUTF16Frontier, sourceUnits);
  }

  recordPublication(publication: Publication): void {
    if (!publication || !this.acceptGeneration(publication.generation)) return;
    if (
      !isNonNegativeInteger(publication.publicationId) ||
      publication.publicationId === 0 ||
      !isNonNegativeInteger(publication.sourceUnits) ||
      !isNonNegativeInteger(publication.semanticPatchCount)
    ) {
      this.addError({
        code: "invalid-publication",
        generation: publication.generation,
        publicationId: publication.publicationId,
        expected: publication.semanticPatchCount,
        observed: publication.sourceUnits,
      });
      return;
    }

    let state = this.publications.get(publication.publicationId);
    if (!state) {
      state = { tagTransactions: new Map(), invalid: false };
      this.publications.set(publication.publicationId, state);
    }
    if (state.descriptor) {
      state.invalid = true;
      this.addError({
        code: "duplicate-publication",
        generation: publication.generation,
        publicationId: publication.publicationId,
      });
      return;
    }
    state.descriptor = Object.freeze({ ...publication });
    this.parsedUTF16Frontier = Math.max(this.parsedUTF16Frontier, publication.sourceUnits);
    this.validatePublicationTags(publication.publicationId, state);
    this.validatePublicationOrder();
  }

  recordWorkerOut(message: WorkerOut): void {
    if (message.type !== "PATCH") return;
    if (!Array.isArray(message.patches) || !Number.isSafeInteger(message.tx) || message.tx < 0) {
      this.addError({ code: "invalid-worker-message", generation: this.activeGeneration ?? undefined, tx: message.tx });
      return;
    }
    if (this.activeGeneration === null) {
      this.addError({ code: "stale-generation", tx: message.tx });
      return;
    }

    const tx = message.tx;
    let transaction = this.transactions.get(tx);
    if (transaction?.received) {
      transaction.invalid = true;
      this.invalidateTagPublications(transaction.tags);
      this.addError({ code: "duplicate-transaction", generation: this.activeGeneration, tx });
      return;
    }
    if (!transaction) {
      transaction = { received: false, tags: [], flushSemanticPatchCount: 0, invalid: false };
      this.transactions.set(tx, transaction);
    }
    transaction.received = true;
    const tags: DiagnosticPatchTag[] = [];
    let semanticPatchCount = 0;

    for (const patch of message.patches) {
      const isSemantic = getPatchKind(patch) === "semantic";
      const tag = readDiagnosticPatchTag(patch);
      if (isSemantic) {
        semanticPatchCount += 1;
        if (!tag) {
          transaction.invalid = true;
          this.addError({ code: "missing-diagnostic-tag", generation: this.activeGeneration, tx });
          continue;
        }
        if (
          tag.generation !== this.activeGeneration ||
          !isNonNegativeInteger(tag.publicationId) ||
          tag.publicationId === 0 ||
          !isNonNegativeInteger(tag.ordinal)
        ) {
          transaction.invalid = true;
          this.addError({
            code: tag.generation !== this.activeGeneration ? "stale-generation" : "invalid-diagnostic-tag",
            generation: tag.generation,
            publicationId: tag.publicationId,
            ordinal: tag.ordinal,
            tx,
          });
          continue;
        }
        tags.push(tag);
      } else if (tag) {
        transaction.invalid = true;
        this.addError({
          code: "invalid-diagnostic-tag",
          generation: tag.generation,
          publicationId: tag.publicationId,
          ordinal: tag.ordinal,
          tx,
        });
      }
    }

    transaction.semanticPatchCount = semanticPatchCount;
    transaction.tags.push(...tags);
    for (const tag of tags) {
      const publication = this.getPublicationState(tag.publicationId);
      if (publication.tagTransactions.has(tag.ordinal)) {
        publication.invalid = true;
        transaction.invalid = true;
        this.addError({
          code: "duplicate-diagnostic-tag",
          generation: this.activeGeneration,
          publicationId: tag.publicationId,
          ordinal: tag.ordinal,
          tx,
        });
      } else {
        publication.tagTransactions.set(tag.ordinal, tx);
      }
    }
    if (transaction.tags.length !== semanticPatchCount) {
      transaction.invalid = true;
    }
    this.reconcileTransaction(tx, transaction);
  }

  recordPatchFlushResult(generation: number, result: PatchFlushResult): void {
    if (!this.acceptGeneration(generation)) return;
    if (!result || !Array.isArray(result.batches)) {
      this.addError({ code: "invalid-flush-result", generation });
      return;
    }

    for (const batch of result.batches) {
      if (batch.kind !== "semantic") continue;
      const tx = batch.tx;
      if (typeof tx !== "number" || !Number.isSafeInteger(tx) || tx < 0) {
        this.addError({ code: "missing-flush-transaction", generation, observed: batch.patchCount });
        continue;
      }
      if (!isNonNegativeInteger(batch.patchCount)) {
        this.addError({ code: "invalid-flush-result", generation, tx, observed: batch.patchCount });
        continue;
      }
      let transaction = this.transactions.get(tx);
      if (!transaction) {
        transaction = { received: false, tags: [], flushSemanticPatchCount: 0, invalid: false };
        this.transactions.set(tx, transaction);
      }
      transaction.flushSemanticPatchCount += batch.patchCount;
      this.reconcileTransaction(tx, transaction);
    }
  }

  snapshot(): PublicationProgressSnapshot {
    const errors = new Map(this.errors);
    let incomplete = errors.size > 0;

    if (this.activeGeneration !== null && this.engineEnteredUTF16Frontier > this.parsedUTF16Frontier) {
      incomplete = true;
    }
    let expectedPublicationId = 1;
    for (const publicationId of [...this.publications.keys()].sort((a, b) => a - b)) {
      if (publicationId > expectedPublicationId) {
        incomplete = true;
        this.addSnapshotError(errors, {
          code: "missing-publication-descriptor",
          generation: this.activeGeneration ?? undefined,
          publicationId: expectedPublicationId,
        });
        expectedPublicationId = publicationId + 1;
      } else if (publicationId === expectedPublicationId) {
        expectedPublicationId += 1;
      }
    }
    for (const [publicationId, state] of this.publications) {
      const descriptor = state.descriptor;
      if (!descriptor) {
        incomplete = true;
        this.addSnapshotError(errors, {
          code: "missing-publication-descriptor",
          generation: this.activeGeneration ?? undefined,
          publicationId,
        });
        continue;
      }
      if (state.invalid) incomplete = true;
      for (let ordinal = 0; ordinal < descriptor.semanticPatchCount; ordinal += 1) {
        const tx = state.tagTransactions.get(ordinal);
        if (tx === undefined) {
          incomplete = true;
          this.addSnapshotError(errors, {
            code: "missing-publication-ordinal",
            generation: descriptor.generation,
            publicationId,
            ordinal,
            expected: descriptor.semanticPatchCount,
          });
          continue;
        }
        const transaction = this.transactions.get(tx);
        if (!transaction || !transaction.received || transaction.invalid || transaction.semanticPatchCount === undefined || transaction.flushSemanticPatchCount < transaction.semanticPatchCount) {
          incomplete = true;
          if (transaction?.received && !transaction.invalid && transaction.semanticPatchCount !== undefined) {
            this.addSnapshotError(errors, {
              code: "unconsumed-semantic-patches",
              generation: descriptor.generation,
              publicationId,
              ordinal,
              tx,
              expected: transaction.semanticPatchCount,
              observed: transaction.flushSemanticPatchCount,
            });
          }
        }
      }
    }
    for (const [tx, transaction] of this.transactions) {
      if (!transaction.received || transaction.semanticPatchCount === undefined || transaction.invalid) {
        incomplete = true;
        continue;
      }
      if (transaction.flushSemanticPatchCount !== transaction.semanticPatchCount) {
        incomplete = true;
        this.addSnapshotError(errors, {
          code: "unconsumed-semantic-patches",
          generation: this.activeGeneration ?? undefined,
          tx,
          expected: transaction.semanticPatchCount,
          observed: transaction.flushSemanticPatchCount,
        });
      }
    }

    const fullySemanticAppliedUTF16Frontier = this.contiguousAppliedFrontier();
    if (fullySemanticAppliedUTF16Frontier < this.parsedUTF16Frontier) incomplete = true;
    const immutableErrors = Object.freeze([...errors.values()].map((error) => Object.freeze({ ...error })));
    return Object.freeze({
      generation: this.activeGeneration,
      engineEnteredUTF16Frontier: this.engineEnteredUTF16Frontier,
      parsedUTF16Frontier: this.parsedUTF16Frontier,
      fullySemanticAppliedUTF16Frontier,
      incomplete: incomplete || immutableErrors.length > 0,
      errors: immutableErrors,
    });
  }

  private acceptGeneration(generation: number): boolean {
    if (this.activeGeneration === null || generation !== this.activeGeneration) {
      this.addError({ code: "stale-generation", generation });
      return false;
    }
    return true;
  }

  private getPublicationState(publicationId: number): PublicationState {
    let state = this.publications.get(publicationId);
    if (!state) {
      state = { tagTransactions: new Map(), invalid: false };
      this.publications.set(publicationId, state);
    }
    return state;
  }

  private validatePublicationTags(publicationId: number, state: PublicationState): void {
    const descriptor = state.descriptor;
    if (!descriptor) return;
    if (state.tagTransactions.size > descriptor.semanticPatchCount) {
      state.invalid = true;
      this.addError({
        code: "unexpected-diagnostic-tag",
        generation: descriptor.generation,
        publicationId,
        expected: descriptor.semanticPatchCount,
        observed: state.tagTransactions.size,
      });
    }
    for (const ordinal of state.tagTransactions.keys()) {
      if (ordinal >= descriptor.semanticPatchCount) {
        state.invalid = true;
        this.addError({
          code: "unexpected-diagnostic-tag",
          generation: descriptor.generation,
          publicationId,
          ordinal,
          expected: descriptor.semanticPatchCount,
        });
      }
    }
  }

  private validatePublicationOrder(): void {
    const ids = [...this.publications.keys()].sort((a, b) => a - b);
    let previous: Publication | undefined;
    for (const id of ids) {
      const current = this.publications.get(id)?.descriptor;
      if (!current) continue;
      if (previous && current.sourceUnits < previous.sourceUnits) {
        const state = this.publications.get(id);
        if (state) state.invalid = true;
        this.addError({
          code: "publication-frontier-regressed",
          generation: current.generation,
          publicationId: id,
          expected: previous.sourceUnits,
          observed: current.sourceUnits,
        });
      }
      previous = current;
    }
  }

  private reconcileTransaction(tx: number, transaction: TransactionState): void {
    const expected = transaction.semanticPatchCount;
    if (expected === undefined) return;
    if (transaction.flushSemanticPatchCount > expected) {
      transaction.invalid = true;
      this.invalidateTagPublications(transaction.tags);
      this.addError({
        code: "overcounted-flush",
        generation: this.activeGeneration ?? undefined,
        tx,
        expected,
        observed: transaction.flushSemanticPatchCount,
      });
      return;
    }
    if (transaction.received && transaction.tags.length !== expected) {
      transaction.invalid = true;
      this.invalidateTagPublications(transaction.tags);
    }
    if (transaction.flushSemanticPatchCount === expected && transaction.received && transaction.tags.length === expected && !transaction.invalid) {
      return;
    }
  }

  private invalidateTagPublications(tags: readonly DiagnosticPatchTag[]): void {
    for (const tag of tags) {
      const publication = this.publications.get(tag.publicationId);
      if (publication) publication.invalid = true;
    }
  }

  private contiguousAppliedFrontier(): number {
    let frontier = 0;
    for (let publicationId = 1; ; publicationId += 1) {
      const state = this.publications.get(publicationId);
      const descriptor = state?.descriptor;
      if (!state || !descriptor || state.invalid) break;
      let complete = true;
      for (let ordinal = 0; ordinal < descriptor.semanticPatchCount; ordinal += 1) {
        const tx = state.tagTransactions.get(ordinal);
        if (tx === undefined) {
          complete = false;
          break;
        }
        const transaction = this.transactions.get(tx);
        if (
          !transaction ||
          !transaction.received ||
          transaction.invalid ||
          transaction.semanticPatchCount === undefined ||
          transaction.flushSemanticPatchCount !== transaction.semanticPatchCount
        ) {
          complete = false;
          break;
        }
      }
      if (!complete) break;
      frontier = descriptor.sourceUnits;
    }
    return frontier;
  }

  private addError(error: PublicationProgressError): void {
    this.errors.set(errorKey(error), Object.freeze({ ...error }));
  }

  private addSnapshotError(errors: Map<string, PublicationProgressError>, error: PublicationProgressError): void {
    errors.set(errorKey(error), Object.freeze({ ...error }));
  }
}
