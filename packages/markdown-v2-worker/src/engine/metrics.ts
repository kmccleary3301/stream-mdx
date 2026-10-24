import type { PatchMetrics, PerformanceMetrics } from "@stream-mdx/core";

export function now(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}

export function roundMetric(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 1000) / 1000;
}

export function mapToNumberRecord(map: Map<string, number>, roundValues = false): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [key, value] of map.entries()) {
    if (!Number.isFinite(value)) continue;
    result[key] = roundValues ? roundMetric(value) : value;
  }
  return result;
}

export function mapToHighlightRecord(
  map: Map<string, { time: number; count: number }>,
): Record<string, { timeMs: number; count: number }> {
  const result: Record<string, { timeMs: number; count: number }> = {};
  for (const [key, value] of map.entries()) {
    if (!value || value.count <= 0 || !Number.isFinite(value.time)) continue;
    result[key] = {
      count: value.count,
      timeMs: roundMetric(value.time),
    };
  }
  return result;
}

export class WorkerMetricsCollector {
  private readonly grammarEngine: "js" | "wasm";
  private readonly startedAt: number;
  private parseStart: number | null = null;
  private diffStart: number | null = null;
  private serializeStart: number | null = null;
  private tx?: number;

  parseMs = 0;
  enrichMs = 0;
  diffMs = 0;
  serializeMs = 0;
  shikiMs = 0;
  mdxDetectMs = 0;
  patchBytes = 0;
  patchCount = 0;
  queueDepth = 0;
  blocksProduced = 0;
  private readonly blockTypeCounts = new Map<string, number>();
  private readonly blockTypeDurations = new Map<string, number>();
  private readonly blockTypeSizes = new Map<string, number>();
  private readonly highlightByLanguage = new Map<string, { time: number; count: number }>();
  lazyTokenizationRequests = 0;
  lazyTokenizationRangeTotal = 0;
  lazyTokenizationRangeMax = 0;
  lazyTokenizationLatencyTotal = 0;
  lazyTokenizationLatencyMax = 0;
  lazyTokenizationMaxQueue = 0;

  constructor(grammarEngine: "js" | "wasm") {
    this.grammarEngine = grammarEngine;
    this.startedAt = now();
  }

  markParseStart(): void {
    this.parseStart = now();
  }

  markParseEnd(): void {
    if (this.parseStart === null) return;
    this.parseMs += Math.max(0, now() - this.parseStart);
    this.parseStart = null;
  }

  recordEnrich(duration: number | null | undefined): void {
    if (!Number.isFinite(duration ?? Number.NaN)) return;
    this.enrichMs += Math.max(0, Number(duration));
  }

  recordShiki(duration: number | null | undefined): void {
    if (!Number.isFinite(duration ?? Number.NaN)) return;
    this.shikiMs += Math.max(0, Number(duration));
  }

  recordMdxDetect(duration: number | null | undefined): void {
    if (!Number.isFinite(duration ?? Number.NaN)) return;
    this.mdxDetectMs += Math.max(0, Number(duration));
  }

  countBlockType(type: string): void {
    if (!type) return;
    this.blockTypeCounts.set(type, (this.blockTypeCounts.get(type) ?? 0) + 1);
  }

  recordBlockSize(type: string, size: number | null | undefined): void {
    if (!type || !Number.isFinite(size ?? Number.NaN)) return;
    const current = this.blockTypeSizes.get(type) ?? 0;
    this.blockTypeSizes.set(type, current + Math.max(0, Number(size)));
  }

  recordBlockEnrich(type: string, duration: number | null | undefined): void {
    if (!type || !Number.isFinite(duration ?? Number.NaN)) return;
    const previous = this.blockTypeDurations.get(type) ?? 0;
    this.blockTypeDurations.set(type, previous + Math.max(0, Number(duration)));
  }

  recordHighlightForLanguage(lang: string, duration: number | null | undefined): void {
    if (!lang || !Number.isFinite(duration ?? Number.NaN)) return;
    const entry = this.highlightByLanguage.get(lang) ?? { time: 0, count: 0 };
    entry.time += Math.max(0, Number(duration));
    entry.count += 1;
    this.highlightByLanguage.set(lang, entry);
  }

  recordLazyTokenization(rangeLines: number | null | undefined, latencyMs: number | null | undefined, queueDepth: number | null | undefined): void {
    if (Number.isFinite(rangeLines ?? Number.NaN)) {
      const normalized = Math.max(0, Math.floor(Number(rangeLines)));
      this.lazyTokenizationRequests += 1;
      this.lazyTokenizationRangeTotal += normalized;
      if (normalized > this.lazyTokenizationRangeMax) {
        this.lazyTokenizationRangeMax = normalized;
      }
    }
    if (Number.isFinite(latencyMs ?? Number.NaN)) {
      const normalizedLatency = Math.max(0, Number(latencyMs));
      this.lazyTokenizationLatencyTotal += normalizedLatency;
      if (normalizedLatency > this.lazyTokenizationLatencyMax) {
        this.lazyTokenizationLatencyMax = normalizedLatency;
      }
    }
    if (Number.isFinite(queueDepth ?? Number.NaN)) {
      const normalizedQueue = Math.max(0, Math.floor(Number(queueDepth)));
      if (normalizedQueue > this.lazyTokenizationMaxQueue) {
        this.lazyTokenizationMaxQueue = normalizedQueue;
      }
    }
  }

  markDiffStart(): void {
    this.diffStart = now();
  }

  markDiffEnd(): void {
    if (this.diffStart === null) return;
    this.diffMs += Math.max(0, now() - this.diffStart);
    this.diffStart = null;
  }

  beginSerialize(): void {
    this.serializeStart = now();
  }

  endSerialize(): void {
    if (this.serializeStart === null) return;
    this.serializeMs += Math.max(0, now() - this.serializeStart);
    this.serializeStart = null;
  }

  finalizePatch(tx: number, patchCount: number, queueDepth: number, patchBytes: number): void {
    this.tx = tx;
    this.patchCount = patchCount;
    this.queueDepth = queueDepth;
    this.patchBytes = patchBytes;
  }

  setBlocksProduced(count: number): void {
    this.blocksProduced = count;
  }

  toPatchMetrics(changedBlocks: number): PatchMetrics {
    return {
      patchCount: this.patchCount,
      changedBlocks,
      diffTime: roundMetric(this.diffMs),
      parseTime: roundMetric(this.parseMs),
      enrichTime: this.enrichMs ? roundMetric(this.enrichMs) : undefined,
      queueDepth: this.queueDepth || undefined,
      patchBytes: this.patchBytes || undefined,
    };
  }

  toPerformanceMetrics(): PerformanceMetrics {
    return {
      tx: this.tx,
      timestamp: this.startedAt,
      parseMs: roundMetric(this.parseMs),
      parseTime: roundMetric(this.parseMs),
      enrichMs: this.enrichMs ? roundMetric(this.enrichMs) : undefined,
      diffMs: this.diffMs ? roundMetric(this.diffMs) : undefined,
      serializeMs: this.serializeMs ? roundMetric(this.serializeMs) : undefined,
      highlightTime: roundMetric(this.shikiMs),
      shikiMs: this.shikiMs ? roundMetric(this.shikiMs) : undefined,
      mdxDetectMs: this.mdxDetectMs ? roundMetric(this.mdxDetectMs) : undefined,
      patchBytes: this.patchBytes || undefined,
      patchCount: this.patchCount || undefined,
      queueDepth: this.queueDepth || undefined,
      blocksProduced: this.blocksProduced,
      grammarEngine: this.grammarEngine,
      blockCountByType: mapToNumberRecord(this.blockTypeCounts),
      blockEnrichMsByType: mapToNumberRecord(this.blockTypeDurations, true),
      blockSizeByType: mapToNumberRecord(this.blockTypeSizes),
      highlightByLanguage: mapToHighlightRecord(this.highlightByLanguage),
      lazyTokenization:
        this.lazyTokenizationRequests > 0
          ? {
              requests: this.lazyTokenizationRequests,
              avgRangeLines: roundMetric(this.lazyTokenizationRangeTotal / this.lazyTokenizationRequests),
              maxRangeLines: this.lazyTokenizationRangeMax,
              avgLatencyMs: roundMetric(this.lazyTokenizationLatencyTotal / this.lazyTokenizationRequests),
              maxLatencyMs: roundMetric(this.lazyTokenizationLatencyMax),
              maxQueue: this.lazyTokenizationMaxQueue,
            }
          : undefined,
    };
  }
}
