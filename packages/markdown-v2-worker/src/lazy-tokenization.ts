export type LazyTokenizationPriority = "visible" | "prefetch";

export type LazyTokenizationRequest = {
  blockId: string;
  startLine: number;
  endLine: number;
  priority: LazyTokenizationPriority;
  requestedAt: number;
};

const PRIORITY_ORDER: Record<LazyTokenizationPriority, number> = {
  visible: 2,
  prefetch: 1,
};

export function clampLazyRange(startLine: number, endLine: number, totalLines: number): { startLine: number; endLine: number } {
  const clampedStart = Math.max(0, Math.min(Math.floor(startLine), totalLines));
  const clampedEnd = Math.max(clampedStart, Math.min(Math.floor(endLine), totalLines));
  return { startLine: clampedStart, endLine: clampedEnd };
}

export function compareLazyPriority(a: LazyTokenizationPriority, b: LazyTokenizationPriority): number {
  return (PRIORITY_ORDER[a] ?? 0) - (PRIORITY_ORDER[b] ?? 0);
}

export function mergeLazyRequests(
  existing: LazyTokenizationRequest,
  next: LazyTokenizationRequest,
): LazyTokenizationRequest {
  const priority = compareLazyPriority(existing.priority, next.priority) >= 0 ? existing.priority : next.priority;
  const startLine = Math.min(existing.startLine, next.startLine);
  const endLine = Math.max(existing.endLine, next.endLine);
  const useNextTimestamp = compareLazyPriority(next.priority, existing.priority) >= 0;
  return {
    blockId: existing.blockId,
    startLine,
    endLine,
    priority,
    requestedAt: useNextTimestamp ? next.requestedAt : existing.requestedAt,
  };
}

export function lazyRequestRangeSize(request: LazyTokenizationRequest): number {
  return Math.max(0, request.endLine - request.startLine);
}
