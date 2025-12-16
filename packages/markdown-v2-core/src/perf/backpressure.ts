export interface BackpressureConfig {
  targetQueueDepth: number;
  maxQueueDepth: number;
  smoothingFactor: number;
  maxHeavyPatchBudget: number;
  minHeavyPatchBudget: number;
  lowCreditCutoff: number;
}

export const DEFAULT_BACKPRESSURE_CONFIG: BackpressureConfig = {
  targetQueueDepth: 1.25,
  maxQueueDepth: 3,
  smoothingFactor: 0.7,
  maxHeavyPatchBudget: 4,
  minHeavyPatchBudget: 1,
  lowCreditCutoff: 0.5,
};

export function calculateRawCredit(queueDepth: number, config: BackpressureConfig = DEFAULT_BACKPRESSURE_CONFIG): number {
  const depth = Number(queueDepth);
  if (!Number.isFinite(depth)) {
    return 1;
  }
  if (depth <= config.targetQueueDepth) {
    return 1;
  }
  if (depth >= config.maxQueueDepth) {
    return 0;
  }
  const range = Math.max(0.0001, config.maxQueueDepth - config.targetQueueDepth);
  const normalized = (depth - config.targetQueueDepth) / range;
  const credit = 1 - normalized;
  return clampCredit(credit);
}

export function smoothCredit(previousCredit: number, rawCredit: number, smoothingFactor = DEFAULT_BACKPRESSURE_CONFIG.smoothingFactor): number {
  const prev = Number.isFinite(previousCredit) ? previousCredit : 1;
  const raw = Number.isFinite(rawCredit) ? rawCredit : prev;
  const factor = clamp01(smoothingFactor);
  if (factor <= 0) {
    return clampCredit(raw);
  }
  if (factor >= 1) {
    return clampCredit(raw);
  }
  const blended = prev + (raw - prev) * factor;
  return clampCredit(blended);
}

export function calculateSmoothedCredit(queueDepth: number, previousCredit: number, config: BackpressureConfig = DEFAULT_BACKPRESSURE_CONFIG): number {
  const raw = calculateRawCredit(queueDepth, config);
  return smoothCredit(previousCredit, raw, config.smoothingFactor);
}

export function computeHeavyPatchBudget(credit: number, config: BackpressureConfig = DEFAULT_BACKPRESSURE_CONFIG): number {
  if (!Number.isFinite(credit) || credit <= 0) {
    return 0;
  }
  if (credit <= config.lowCreditCutoff) {
    return 0;
  }
  const scaled = Math.floor(credit * config.maxHeavyPatchBudget);
  const budget = Math.max(config.minHeavyPatchBudget, scaled);
  return Math.min(config.maxHeavyPatchBudget, budget);
}

export function clampCredit(value: number): number {
  if (!Number.isFinite(value)) return 1;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}
