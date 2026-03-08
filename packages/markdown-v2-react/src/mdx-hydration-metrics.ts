type MdxHydrationEntry = {
  status: "compiled" | "hydrated" | "error";
  startedAt?: number;
  hydratedAt?: number;
  longTaskMs?: number;
  longTaskCount?: number;
};

type MdxPrefetchEntry = {
  status: "pending" | "completed" | "error";
  startedAt?: number;
  completedAt?: number;
};

export type MdxPrefetchSummary = {
  requested: number;
  completed: number;
  error: number;
  pending: number;
  avgPrefetchMs: number | null;
  p95PrefetchMs: number | null;
  maxPrefetchMs: number | null;
  lastPrefetchMs: number | null;
};

export type MdxHydrationSummary = {
  compiled: number;
  hydrated: number;
  error: number;
  avgHydrationMs: number | null;
  p95HydrationMs: number | null;
  maxHydrationMs: number | null;
  lastHydrationMs: number | null;
  longTaskTotalMs: number | null;
  longTaskCount: number | null;
  p95LongTaskMs: number | null;
  maxLongTaskMs: number | null;
  prefetch?: MdxPrefetchSummary | null;
};

const entries = new Map<string, MdxHydrationEntry>();
let lastHydrationMs: number | null = null;
const hydrationLongTasks: number[] = [];
const prefetchEntries = new Map<string, MdxPrefetchEntry>();
let lastPrefetchMs: number | null = null;

function now(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

export function markMdxHydrationStart(id: string | undefined): void {
  if (!id) return;
  const entry = entries.get(id) ?? { status: "compiled" };
  if (entry.startedAt === undefined) {
    entry.startedAt = now();
  }
  entry.status = "compiled";
  entries.set(id, entry);
}

export function markMdxHydrated(id: string | undefined): void {
  if (!id) return;
  const entry = entries.get(id) ?? { status: "hydrated" };
  if (entry.startedAt === undefined) {
    entry.startedAt = now();
  }
  entry.hydratedAt = now();
  entry.status = "hydrated";
  entries.set(id, entry);
  lastHydrationMs = entry.startedAt ? entry.hydratedAt - entry.startedAt : null;
}

export function markMdxHydrationError(id: string | undefined): void {
  if (!id) return;
  const entry = entries.get(id) ?? { status: "error" };
  entry.status = "error";
  entries.set(id, entry);
}

export function markMdxPrefetchStart(id: string | undefined): void {
  if (!id) return;
  const entry = prefetchEntries.get(id) ?? { status: "pending" };
  if (entry.startedAt === undefined) {
    entry.startedAt = now();
  }
  entry.status = "pending";
  prefetchEntries.set(id, entry);
}

export function markMdxPrefetchComplete(id: string | undefined): void {
  if (!id) return;
  const entry = prefetchEntries.get(id) ?? { status: "completed" };
  if (entry.startedAt === undefined) {
    entry.startedAt = now();
  }
  entry.completedAt = now();
  entry.status = "completed";
  prefetchEntries.set(id, entry);
  lastPrefetchMs = entry.startedAt ? entry.completedAt - entry.startedAt : null;
}

export function markMdxPrefetchError(id: string | undefined): void {
  if (!id) return;
  const entry = prefetchEntries.get(id) ?? { status: "error" };
  entry.status = "error";
  prefetchEntries.set(id, entry);
}

export function markMdxPrefetchCancelled(id: string | undefined): void {
  if (!id) return;
  prefetchEntries.delete(id);
}

export function recordMdxHydrationLongTask(startTime: number, duration: number): void {
  if (!Number.isFinite(startTime) || !Number.isFinite(duration)) return;
  const endTime = startTime + duration;
  let matched = false;
  for (const entry of entries.values()) {
    if (entry.startedAt === undefined) continue;
    const hydratedAt = entry.hydratedAt ?? now();
    if (endTime >= entry.startedAt && startTime <= hydratedAt) {
      entry.longTaskMs = (entry.longTaskMs ?? 0) + duration;
      entry.longTaskCount = (entry.longTaskCount ?? 0) + 1;
      matched = true;
    }
  }
  if (matched) {
    hydrationLongTasks.push(duration);
  }
}

export function getMdxPrefetchSummary(): MdxPrefetchSummary {
  let requested = 0;
  let completed = 0;
  let error = 0;
  let pending = 0;
  const durations: number[] = [];

  for (const entry of prefetchEntries.values()) {
    requested += 1;
    if (entry.status === "completed") {
      completed += 1;
    } else if (entry.status === "error") {
      error += 1;
    } else {
      pending += 1;
    }
    if (entry.startedAt !== undefined && entry.completedAt !== undefined) {
      durations.push(entry.completedAt - entry.startedAt);
    }
  }

  const avgPrefetchMs = durations.length > 0 ? durations.reduce((sum, value) => sum + value, 0) / durations.length : null;
  const maxPrefetchMs = durations.length > 0 ? Math.max(...durations) : null;
  const p95PrefetchMs = durations.length > 0 ? percentile(durations, 0.95) : null;

  return {
    requested,
    completed,
    error,
    pending,
    avgPrefetchMs,
    p95PrefetchMs,
    maxPrefetchMs,
    lastPrefetchMs,
  };
}

export function getMdxHydrationSummary(): MdxHydrationSummary {
  let compiled = 0;
  let hydrated = 0;
  let error = 0;
  const durations: number[] = [];
  let longTaskTotal = 0;
  let longTaskCount = 0;

  for (const entry of entries.values()) {
    if (entry.status === "compiled") {
      compiled += 1;
    } else if (entry.status === "hydrated") {
      hydrated += 1;
    } else if (entry.status === "error") {
      error += 1;
    }
    if (entry.startedAt !== undefined && entry.hydratedAt !== undefined) {
      durations.push(entry.hydratedAt - entry.startedAt);
    }
    if (entry.longTaskMs) {
      longTaskTotal += entry.longTaskMs;
    }
    if (entry.longTaskCount) {
      longTaskCount += entry.longTaskCount;
    }
  }

  const avgHydrationMs = durations.length > 0 ? durations.reduce((sum, value) => sum + value, 0) / durations.length : null;
  const maxHydrationMs = durations.length > 0 ? Math.max(...durations) : null;
  const p95HydrationMs = durations.length > 0 ? percentile(durations, 0.95) : null;
  const longTaskTotalMs = longTaskCount > 0 ? longTaskTotal : null;
  const maxLongTaskMs = hydrationLongTasks.length > 0 ? Math.max(...hydrationLongTasks) : null;
  const p95LongTaskMs = hydrationLongTasks.length > 0 ? percentile(hydrationLongTasks, 0.95) : null;
  const prefetch = getMdxPrefetchSummary();

  return {
    compiled,
    hydrated,
    error,
    avgHydrationMs,
    p95HydrationMs,
    maxHydrationMs,
    lastHydrationMs,
    longTaskTotalMs,
    longTaskCount: longTaskCount > 0 ? longTaskCount : null,
    p95LongTaskMs,
    maxLongTaskMs,
    prefetch,
  };
}

export function resetMdxHydrationMetrics(): void {
  entries.clear();
  lastHydrationMs = null;
  hydrationLongTasks.length = 0;
  prefetchEntries.clear();
  lastPrefetchMs = null;
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(ratio * sorted.length)));
  return sorted[index];
}
