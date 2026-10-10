export type ComparisonEvidence = {
  metadata?: {
    profile?: string;
    policy?: Record<string, unknown>;
    fixtureHash?: string;
    chunkTraceHash?: string;
    chunkCount?: number;
  };
  config: { fixture: string; scenario: string; profile?: string; runs: number };
  runs?: Array<{ semanticContent: { normalizedTextHash: string } | null; cdp: { taskMs: number | null } | null }>;
  aggregate: { semanticTextHash?: string | null; cdpTaskMs?: { count: number; p50: number } | null };
};

export function comparisonInvalidity(base: ComparisonEvidence, candidate: ComparisonEvidence): string[] {
  const invalid: string[] = [];
  for (const [label, summary] of [["base", base], ["candidate", candidate]] as const) {
    const metadata = summary.metadata;
    for (const [name, hash] of [["semantic", summary.aggregate.semanticTextHash], ["fixture", metadata?.fixtureHash], ["chunk trace", metadata?.chunkTraceHash]] as const) {
      if (!hash || !/^[a-f0-9]{64}$/.test(hash)) invalid.push(`${label} ${name} hash missing or invalid`);
    }
    if (!metadata?.chunkCount || !Number.isInteger(metadata.chunkCount) || metadata.chunkCount < 1) invalid.push(`${label} chunk count missing or invalid`);
    if (!summary.config.scenario || !summary.config.fixture || !summary.config.profile) invalid.push(`${label} workload configuration missing`);
    if (!Number.isInteger(summary.config.runs) || summary.config.runs < 1 || summary.runs?.length !== summary.config.runs) invalid.push(`${label} measured run evidence incomplete`);
    if (!summary.aggregate.cdpTaskMs || summary.aggregate.cdpTaskMs.count !== summary.config.runs || !Number.isFinite(summary.aggregate.cdpTaskMs.p50)) invalid.push(`${label} median CDP TaskDuration missing or invalid`);
    if (metadata?.profile !== summary.config.profile || !metadata?.policy || Object.keys(metadata.policy).length === 0) invalid.push(`${label} feature policy missing or inconsistent`);
    for (const run of summary.runs ?? []) {
      if (run.semanticContent?.normalizedTextHash !== summary.aggregate.semanticTextHash) invalid.push(`${label} per-run semantic hash differs from aggregate`);
      if (run.cdp?.taskMs === null || run.cdp?.taskMs === undefined || !Number.isFinite(run.cdp.taskMs) || run.cdp.taskMs < 0) invalid.push(`${label} per-run CDP TaskDuration missing or invalid`);
    }
  }
  if (base.aggregate.semanticTextHash !== candidate.aggregate.semanticTextHash) invalid.push("canonical semantic records diverge");
  if (base.metadata?.fixtureHash !== candidate.metadata?.fixtureHash || base.config.fixture !== candidate.config.fixture) invalid.push("fixture differs");
  if (base.metadata?.chunkTraceHash !== candidate.metadata?.chunkTraceHash || base.metadata?.chunkCount !== candidate.metadata?.chunkCount || base.config.scenario !== candidate.config.scenario) invalid.push("chunk trace or scenario differs");
  if (base.config.profile !== candidate.config.profile || base.metadata?.profile !== candidate.metadata?.profile || JSON.stringify(base.metadata?.policy) !== JSON.stringify(candidate.metadata?.policy)) invalid.push("feature policy differs");
  return invalid;
}
