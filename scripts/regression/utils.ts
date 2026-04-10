import fs from "node:fs/promises";
import path from "node:path";

import { REGRESSION_FIXTURES, type RegressionFixture } from "../../tests/regression/fixtures";

export type RegressionScenario = {
  id: string;
  label: string;
  updateIntervalMs: number;
  charRateCps: number;
  maxChunkChars: number;
  useSplitMarkers?: boolean;
  includeTags?: string[];
  excludeTags?: string[];
};

const FIXTURE_DIR = path.resolve(process.cwd(), "tests/regression/fixtures");
const SCENARIO_DIR = path.resolve(process.cwd(), "tests/regression/scenarios");
const SPLIT_MARKER = "<!--split-->";

export async function loadScenarioFiles(): Promise<RegressionScenario[]> {
  const entries = await fs.readdir(SCENARIO_DIR);
  const scenarios: RegressionScenario[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const raw = await fs.readFile(path.join(SCENARIO_DIR, entry), "utf8");
    scenarios.push(JSON.parse(raw) as RegressionScenario);
  }
  return scenarios;
}

export function getFixtures(): RegressionFixture[] {
  return REGRESSION_FIXTURES;
}

export async function readFixtureFile(file: string): Promise<string> {
  return await fs.readFile(path.join(FIXTURE_DIR, file), "utf8");
}

export function shouldRunScenario(fixture: RegressionFixture, scenario: RegressionScenario): boolean {
  const tags = new Set(fixture.tags ?? []);
  // Fixtures with explicit split markers only make sense when the harness is
  // instructed to honor them instead of leaving literal HTML comments inline.
  if (tags.has("split-markers") && !scenario.useSplitMarkers) return false;
  const include = scenario.includeTags ?? [];
  const exclude = scenario.excludeTags ?? [];
  if (include.length > 0 && !include.some((tag) => tags.has(tag))) return false;
  if (exclude.length > 0 && exclude.some((tag) => tags.has(tag))) return false;
  return true;
}

export function splitMarkers(content: string): { text: string; chunks: string[] } | null {
  if (!content.includes(SPLIT_MARKER)) return null;
  const parts = content.split(SPLIT_MARKER);
  return { text: parts.join(""), chunks: parts };
}

export function buildChunks(text: string, scenario: RegressionScenario): string[] {
  const rawChunk = Math.floor((scenario.charRateCps * scenario.updateIntervalMs) / 1000);
  const chunkSize = Math.max(1, Math.min(scenario.maxChunkChars, rawChunk));
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push(text.slice(i, i + chunkSize));
  }
  return chunks.length > 0 ? chunks : [text];
}

function hashSeed(seed: string): number {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function createSeededRng(seed: string): () => number {
  let state = hashSeed(seed) || 1;
  return () => {
    state = Math.imul(state, 1664525) + 1013904223;
    state >>>= 0;
    return state / 0xffffffff;
  };
}

export function buildSeededChunks(text: string, scenario: RegressionScenario, seed: string): string[] {
  const baseRawChunk = Math.floor((scenario.charRateCps * scenario.updateIntervalMs) / 1000);
  const baseChunkSize = Math.max(1, Math.min(scenario.maxChunkChars, baseRawChunk));
  const maxChunkSize = Math.max(baseChunkSize, scenario.maxChunkChars);
  const minChunkSize = Math.max(1, Math.min(baseChunkSize, Math.max(1, Math.floor(baseChunkSize * 0.35))));
  const nextRandom = createSeededRng(seed);
  const chunks: string[] = [];
  let index = 0;

  while (index < text.length) {
    const jitter = minChunkSize + Math.floor(nextRandom() * (maxChunkSize - minChunkSize + 1));
    const remaining = text.length - index;
    const size = Math.max(1, Math.min(remaining, jitter));
    chunks.push(text.slice(index, index + size));
    index += size;
  }

  return chunks.length > 0 ? chunks : [text];
}

export function progressCheckpoints(totalLength: number): number[] {
  const percentages = [0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 1];
  const values = new Set<number>();
  for (const pct of percentages) {
    const value = Math.max(1, Math.round(totalLength * pct));
    values.add(Math.min(totalLength, value));
  }
  return Array.from(values).sort((a, b) => a - b);
}

export function isSplitScenario(scenario: RegressionScenario): boolean {
  return Boolean(scenario.useSplitMarkers);
}

export function firstDiffIndex(a: string, b: string): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    if (a[i] !== b[i]) return i;
  }
  if (a.length !== b.length) return len;
  return -1;
}

export function diffContext(value: string, index: number, span = 80): string {
  if (index < 0) return "";
  const start = Math.max(0, index - span);
  const end = Math.min(value.length, index + span);
  return value.slice(start, end);
}
