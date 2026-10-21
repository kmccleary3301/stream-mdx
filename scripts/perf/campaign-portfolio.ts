/**
 * Truthful campaign observation portfolio, deterministic fixture generators,
 * chunk traces, and observation metadata types for ownership slice 1.
 *
 * All inputs are deterministic ASCII UTF-16 code units.
 */

export type CampaignObservationId =
  | "code-262k"
  | "table-250"
  | "list-500"
  | "finalize-253k"
  | "finalize-1000k"
  | "short-code";

export type CampaignObservationArea =
  | "huge-code"
  | "containers"
  | "finalize"
  | "short-message";

export interface CampaignScenarioConfig {
  id: string;
  label: string;
  updateIntervalMs: number;
  charRateCps: number;
  maxChunkChars: number;
}

export interface CampaignObservationDef {
  id: CampaignObservationId;
  aliases: string[];
  area: CampaignObservationArea;
  label: string;
  decimalSizeLabel: string;
  targetUnits: number;
  isCold: boolean;
  expectedAuthoredSnippet: string;
  getFixture: () => string;
  scenario: CampaignScenarioConfig;
  getTrace: () => Array<{ atMs: number; text: string }>;
  fixtureHash: string;
  traceHash: string;
  chunkCount: number;
}

export interface CampaignLifecycleTimestamps {
  streamRequestedAt: number;
  workerBootRequestedAt: number | null;
  initializedAt: number | null;
  firstAppendAt: number | null;
  firstSemanticCommitAt: number | null;
  firstAuthoredTextAt: number | null;
  fenceClosedAt: number | null;
  finalizeRequestedAt: number | null;
  finalizeAckAt: number | null;
  schedulerDrainedAt: number | null;
  decorationReadyAt: number | null;
  runEnd: number;
}

export interface CampaignLifecycleDurations {
  timeToWorkerInitializedMs: number | null;
  timeFromInitializedToFirstAppendMs: number | null;
  timeToFirstSemanticCommitMs: number | null;
  coldFirstAuthoredTextMs: number | null;
  postReadyFirstAuthoredTextMs: number | null;
  fenceCloseToFinalizeMs: number | null;
  finalizeRequestToAckDurationMs: number | null;
  workerFinalizeDuration: {
    available: false;
    reason: "worker internal finalize parse/enrich time not reported separately in WorkerOut";
  };
  schedulerDrainDurationMs: number | null;
  decorationReadinessDurationMs: number | null;
  totalRunDurationMs: number;
}

export interface CampaignFrontierObservation {
  offeredUnits: number;
  acceptedUnits: number;
  dispatchedUnits: number;
  processedUnits: {
    available: false;
    reason: "missing engine hook: publication-time processed UTF-16 frontier";
    offset: null;
  };
  committedUnits: {
    available: false;
    reason: "missing engine hook: publication-correlated committed source frontier";
    offset: null;
  };
  storeBlockRawCharsTotal: number | null;
  visibleSourceRange: {
    available: false;
    reason: "unobservable without engine source-range mapping to DOM viewport";
  };
  highlightedSourceRange: {
    available: false;
    reason: "unobservable without engine token source-range mapping";
  };
  mountedDomTextChars: number | null;
  presentationNote: "DOM mount / rAF is presentation availability, not proven compositor paint or viewport progress";
  producerSchedule: {
    nominalTotalMs: number;
    actualProducerDurationMs: number;
    maxDelayMs: number;
    avgDelayMs: number;
    delayedTicksCount: number;
    totalTicks: number;
  };
}

export interface CampaignResourceObservation {
  mainThreadMemory: {
    available: boolean;
    peakUsedJSHeapSizeMB: number | null;
  };
  workerHeap: {
    available: false;
    reason: "page performance.memory reflects only main-thread V8 heap, not isolated Worker heap; worker heap observation unavailable without CDP worker target probe";
  };
  workerCpu: {
    available: false;
    reason: "worker CPU usage unavailable without CDP Node/Worker target domain";
  };
}

export interface CampaignWorkCounters {
  available: false;
  reason: "diagnostic stage counters (lines_tokenized, blocks_reprepared, store_records_touched) require the private CounterSeams diagnostic sink which is not on the production path";
  counters: null;
}

export interface CampaignObservationResult {
  observationId: CampaignObservationId;
  area: CampaignObservationArea;
  resolvedConfig: {
    renderer: string;
    profile: string;
    codeHighlighting: string;
    scheduling: string;
    isCold: boolean;
    targetUnits: number;
    decimalSizeLabel: string;
    updateIntervalMs: number;
    charRateCps: number;
    maxChunkChars: number;
  };
  timestamps: CampaignLifecycleTimestamps;
  durations: CampaignLifecycleDurations;
  frontier: CampaignFrontierObservation;
  resources: CampaignResourceObservation;
  workCounters: CampaignWorkCounters;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateHugeCode(targetUnits = 262144): string {
  const header =
    "```typescript\n// Deterministic campaign huge code fixture\nexport interface ItemRecord {\n  id: number;\n  name: string;\n  score: number;\n}\n\n";
  const footer = "\n```\n";
  const available = targetUnits - header.length - footer.length;
  if (available < 0) throw new Error("targetUnits too small for code block structure");

  const lines: string[] = [];
  let currentLen = 0;
  let idx = 1;
  while (true) {
    const linePrefix = `const record_${String(idx).padStart(6, "0")} = { id: ${idx}, val: ${(idx * 37 + 101) % 9973} }; // `;
    const remBefore = available - currentLen;
    if (remBefore < linePrefix.length + 2) break;
    const targetLineLen = Math.min(80, remBefore);
    if (targetLineLen < linePrefix.length + 2) break;
    const padLen = targetLineLen - linePrefix.length - 1;
    const line = linePrefix + "-".repeat(padLen) + "\n";
    lines.push(line);
    currentLen += line.length;
    idx += 1;
  }
  const rem = available - currentLen;
  if (rem > 0) {
    if (rem === 1) {
      lines.push("\n");
    } else {
      lines.push("// " + "=".repeat(rem - 4) + "\n");
    }
  }
  const result = header + lines.join("") + footer;
  if (result.length !== targetUnits) {
    throw new Error(`Huge code length mismatch: expected ${targetUnits}, got ${result.length}`);
  }
  return result;
}

export function generateContainerTable(rowCount = 250): {
  fixture: string;
  trace: Array<{ atMs: number; text: string }>;
} {
  const header =
    "| Row | Key | Metric A | Metric B | Status | Notes |\n| :--- | :--- | :--- | :--- | :--- | :--- |\n";
  const rows: string[] = [];
  const trace: Array<{ atMs: number; text: string }> = [];

  trace.push({ atMs: 20, text: header });

  for (let i = 1; i <= rowCount; i += 1) {
    const key = `rec-${String(i).padStart(3, "0")}`;
    const a = (1000 + i * 1.25).toFixed(2);
    const b = (2000 + i * 2.5).toFixed(2);
    const status = i % 2 === 0 ? "active" : "pending";
    const row = `| ${String(i).padStart(3, "0")} | ${key} | ${a} | ${b} | ${status} | Table row container record ${String(i).padStart(3, "0")} |\n`;
    rows.push(row);
    trace.push({ atMs: 20 * (i + 1), text: row });
  }

  const fixture = header + rows.join("");
  return { fixture, trace };
}

export function generateContainerList(itemCount = 500): {
  fixture: string;
  trace: Array<{ atMs: number; text: string }>;
} {
  const items: string[] = [];
  const trace: Array<{ atMs: number; text: string }> = [];

  for (let i = 1; i <= itemCount; i += 1) {
    const item = `${i}. List item ${String(i).padStart(3, "0")}: deterministic streaming container payload entry with standard ASCII metrics\n`;
    items.push(item);
    trace.push({ atMs: 20 * i, text: item });
  }

  const fixture = items.join("");
  return { fixture, trace };
}

export function generateFinalizeSource(targetUnits: number, title: string, seed: number): string {
  const rng = mulberry32(seed);
  const parts: string[] = [`# ${title}\n\nDeterministic finalize benchmark payload.\n`];
  let currentLen = parts[0].length;
  let sectionIndex = 1;

  while (currentLen < targetUnits - 200) {
    const secTitle = `\n## Section ${sectionIndex}: Overview and Diagnostics\n\n`;
    const para = `This is a benchmark section containing prose text designed to test parser performance and finalize characteristics. Value: ${(rng() * 10000).toFixed(2)}. Buffer capacity and token limits are strictly enforced during streaming ingestion.\n\n`;
    const list = `- Point A: verification and ordering invariant check ${(rng() * 100).toFixed(0)}\n- Point B: boundary conditions for containers and tables ${(rng() * 100).toFixed(0)}\n- Point C: decoration readiness and post-finalize settle ${(rng() * 100).toFixed(0)}\n\n`;
    const block = secTitle + para + list;
    if (currentLen + block.length > targetUnits - 100) break;
    parts.push(block);
    currentLen += block.length;
    sectionIndex += 1;
  }

  const remaining = targetUnits - currentLen;
  if (remaining > 0) {
    const prefix = "<!-- pad: ";
    const suffix = " -->\n";
    const overhead = prefix.length + suffix.length;
    if (remaining >= overhead) {
      parts.push(prefix + "-".repeat(remaining - overhead) + suffix);
    } else {
      parts.push("\n".repeat(remaining));
    }
  }
  const result = parts.join("");
  if (result.length !== targetUnits) {
    throw new Error(`Finalize source length mismatch: expected ${targetUnits}, got ${result.length}`);
  }
  return result;
}

export function generateShortCode(): string {
  return "```typescript\ninterface Point2D {\n  x: number;\n  y: number;\n}\nconst origin: Point2D = { x: 0, y: 0 };\n```\n";
}

export function createStandardChunkTrace(
  source: string,
  scenario: { updateIntervalMs: number; charRateCps: number; maxChunkChars: number },
): Array<{ atMs: number; text: string }> {
  if (!Number.isFinite(scenario.charRateCps) || scenario.charRateCps <= 0) {
    throw new Error("Invalid scenario character rate.");
  }
  const interval = Math.max(1, scenario.updateIntervalMs);
  const ceiling = Math.max(1, Math.floor(scenario.maxChunkChars));
  const trace: Array<{ atMs: number; text: string }> = [];
  let offset = 0;
  let credit = 0;
  for (let tick = 1; offset < source.length; tick += 1) {
    credit += (scenario.charRateCps * interval) / 1000;
    const size = Math.min(Math.floor(credit), ceiling, source.length - offset);
    if (size === 0) continue;
    trace.push({ atMs: tick * interval, text: source.slice(offset, offset + size) });
    offset += size;
    credit -= size;
  }
  return trace;
}

let cachedHugeCode: string | null = null;
let cachedTable: { fixture: string; trace: Array<{ atMs: number; text: string }> } | null = null;
let cachedList: { fixture: string; trace: Array<{ atMs: number; text: string }> } | null = null;
let cachedFinalize253k: string | null = null;
let cachedFinalize1000k: string | null = null;
let cachedShortCode: string | null = null;

export const CAMPAIGN_OBSERVATIONS: Record<CampaignObservationId, CampaignObservationDef> = {
  "code-262k": {
    id: "code-262k",
    aliases: ["huge-code", "huge_code", "campaign-huge-code"],
    area: "huge-code",
    label: "Huge code block (262,144 UTF-16 units / ASCII at 50,000 cps)",
    decimalSizeLabel: "262,144 UTF-16 units (262 KB decimal)",
    targetUnits: 262144,
    isCold: false,
    expectedAuthoredSnippet: "ItemRecord",
    getFixture: () => {
      if (!cachedHugeCode) cachedHugeCode = generateHugeCode(262144);
      return cachedHugeCode;
    },
    scenario: {
      id: "code-262k",
      label: "Campaign 50k cps, 20ms ticks <= 1000 units",
      updateIntervalMs: 20,
      charRateCps: 50000,
      maxChunkChars: 1000,
    },
    getTrace: () => {
      const fix = CAMPAIGN_OBSERVATIONS["code-262k"].getFixture();
      return createStandardChunkTrace(fix, CAMPAIGN_OBSERVATIONS["code-262k"].scenario);
    },
    fixtureHash: "42dc0e8e3044400bdbbfcdbe997747df5f21a3c36885fd114bcf000c636bf34d",
    traceHash: "ef52ca72e41f376ddee4e3d70b54c5520dd2c111657b6831f903b82026cb131a",
    chunkCount: 263,
  },
  "table-250": {
    id: "table-250",
    aliases: ["container-table", "container_table", "table_250"],
    area: "containers",
    label: "Container fixed-column table (250 rows, 1 row per 20ms tick)",
    decimalSizeLabel: "20,222 UTF-16 units (250 rows)",
    targetUnits: 20222,
    isCold: false,
    expectedAuthoredSnippet: "Table row container record",
    getFixture: () => {
      if (!cachedTable) cachedTable = generateContainerTable(250);
      return cachedTable.fixture;
    },
    scenario: {
      id: "table-250",
      label: "Container table 1 row per 20ms tick",
      updateIntervalMs: 20,
      charRateCps: 10000,
      maxChunkChars: 256,
    },
    getTrace: () => {
      if (!cachedTable) cachedTable = generateContainerTable(250);
      return cachedTable.trace;
    },
    fixtureHash: "c4eef6bd37d14998188509b046d70126144edd2a071bc642a5e1e4e2c38a787d",
    traceHash: "8eacd254a2aea19d51bb70975377d5d1c9dc08c2632396c6661af0ead0709c43",
    chunkCount: 251,
  },
  "list-500": {
    id: "list-500",
    aliases: ["container-list", "container_list", "list_500"],
    area: "containers",
    label: "Container list (500 items, 1 item per 20ms tick)",
    decimalSizeLabel: "47,892 UTF-16 units (500 items)",
    targetUnits: 47892,
    isCold: false,
    expectedAuthoredSnippet: "List item",
    getFixture: () => {
      if (!cachedList) cachedList = generateContainerList(500);
      return cachedList.fixture;
    },
    scenario: {
      id: "list-500",
      label: "Container list 1 item per 20ms tick",
      updateIntervalMs: 20,
      charRateCps: 10000,
      maxChunkChars: 256,
    },
    getTrace: () => {
      if (!cachedList) cachedList = generateContainerList(500);
      return cachedList.trace;
    },
    fixtureHash: "26b3408e0a9147fac72b6518806c49e82e5a969504062be3fd9eae4306ae8425",
    traceHash: "29e5659e2134888f16e6f310ae0240cb09de38d1b6fab51a8fe9b9c657db121e",
    chunkCount: 500,
  },
  "finalize-253k": {
    id: "finalize-253k",
    aliases: ["finalize_253k", "finalize-253000"],
    area: "finalize",
    label: "Finalize source 253k (253,000 UTF-16 units / ASCII)",
    decimalSizeLabel: "253,000 UTF-16 units (253 KB decimal)",
    targetUnits: 253000,
    isCold: false,
    expectedAuthoredSnippet: "Deterministic finalize benchmark payload",
    getFixture: () => {
      if (!cachedFinalize253k) {
        cachedFinalize253k = generateFinalizeSource(253000, "Campaign Finalize Benchmark: 253K Source", 42);
      }
      return cachedFinalize253k;
    },
    scenario: {
      id: "finalize-253k",
      label: "Campaign finalize 253k at 50,000 cps",
      updateIntervalMs: 20,
      charRateCps: 50000,
      maxChunkChars: 1000,
    },
    getTrace: () => {
      const fix = CAMPAIGN_OBSERVATIONS["finalize-253k"].getFixture();
      return createStandardChunkTrace(fix, CAMPAIGN_OBSERVATIONS["finalize-253k"].scenario);
    },
    fixtureHash: "61a81164b4f9722ea5845a09b9968689e8917bea082868cb05ea66dbb73405f8",
    traceHash: "f407ef3d1bd641c8f40e263899304453c2a31b9afcd0e5193fc2159579e0bb23",
    chunkCount: 253,
  },
  "finalize-1000k": {
    id: "finalize-1000k",
    aliases: ["finalize-1m", "finalize_1000k", "finalize-1000000"],
    area: "finalize",
    label: "Finalize source 1000k (1,000,000 UTF-16 units / ASCII)",
    decimalSizeLabel: "1,000,000 UTF-16 units (1,000 KB decimal / 1 MB decimal)",
    targetUnits: 1000000,
    isCold: false,
    expectedAuthoredSnippet: "Deterministic finalize benchmark payload",
    getFixture: () => {
      if (!cachedFinalize1000k) {
        cachedFinalize1000k = generateFinalizeSource(1000000, "Campaign Finalize Benchmark: 1000K Source", 99);
      }
      return cachedFinalize1000k;
    },
    scenario: {
      id: "finalize-1000k",
      label: "Campaign finalize 1000k at 50,000 cps",
      updateIntervalMs: 20,
      charRateCps: 50000,
      maxChunkChars: 1000,
    },
    getTrace: () => {
      const fix = CAMPAIGN_OBSERVATIONS["finalize-1000k"].getFixture();
      return createStandardChunkTrace(fix, CAMPAIGN_OBSERVATIONS["finalize-1000k"].scenario);
    },
    fixtureHash: "b816d503488878e6277fa862782044bb1dac2fd07cdf8e9edf81b1f97ff68a15",
    traceHash: "2c8a71edb1fe3f83e71feadc15af41195831c82102b946a02bffd178f916d3ad",
    chunkCount: 1000,
  },
  "short-code": {
    id: "short-code",
    aliases: ["short-message", "short_message", "short_code"],
    area: "short-message",
    label: "Short TS code fence (~5 lines, cold mount-to-authored-text clock)",
    decimalSizeLabel: "106 UTF-16 units (~5-line TS fence)",
    targetUnits: 106,
    isCold: true,
    expectedAuthoredSnippet: "Point2D",
    getFixture: () => {
      if (!cachedShortCode) cachedShortCode = generateShortCode();
      return cachedShortCode;
    },
    scenario: {
      id: "short-code",
      label: "Cold short message trace",
      updateIntervalMs: 20,
      charRateCps: 2000,
      maxChunkChars: 64,
    },
    getTrace: () => {
      const fix = CAMPAIGN_OBSERVATIONS["short-code"].getFixture();
      return createStandardChunkTrace(fix, CAMPAIGN_OBSERVATIONS["short-code"].scenario);
    },
    fixtureHash: "f024e5809a7c8bed1b85aa26eee3d17c8777a9758cff2364a8d774404bf49da9",
    traceHash: "29e4631dc05eefa8e037ea34382ab3603e5b25421cb5c98c8a79fbdd98405fc5",
    chunkCount: 3,
  },
};

export function resolveCampaignObservation(identifier: string | null): CampaignObservationDef | null {
  if (!identifier) return null;
  const normalized = identifier.trim().toLowerCase();
  for (const def of Object.values(CAMPAIGN_OBSERVATIONS)) {
    if (def.id.toLowerCase() === normalized) return def;
    if (def.aliases.some((alias) => alias.toLowerCase() === normalized)) return def;
  }
  return null;
}

