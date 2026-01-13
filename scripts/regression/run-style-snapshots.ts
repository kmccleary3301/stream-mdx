import path from "node:path";
import fs from "node:fs/promises";

import { chromium } from "@playwright/test";

import { STYLE_TARGETS } from "../../tests/regression/style-targets";
import {
  getFixtures,
  loadScenarioFiles,
  readFixtureFile,
  splitMarkers,
  buildChunks,
  shouldRunScenario,
  isSplitScenario,
} from "./utils";
import type { RegressionScenario } from "./utils";

const UPDATE = process.env.UPDATE_SNAPSHOTS === "1" || process.env.UPDATE_SNAPSHOTS === "true";
const BASE_URL = process.env.STREAM_MDX_REGRESSION_BASE_URL || "http://localhost:3000";
const SNAPSHOT_ROOT = path.resolve(process.cwd(), "tests/regression/snapshots/styles");
const ARTIFACT_ROOT = path.resolve(process.cwd(), "tests/regression/artifacts");

function getArg(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

type StyleSnapshot = {
  fixtureId: string;
  fixtureTitle: string;
  scenarioId: string;
  scenario: RegressionScenario;
  targets: Record<string, unknown>;
};

async function writeSnapshot(snapshotPath: string, data: StyleSnapshot): Promise<void> {
  await ensureDir(path.dirname(snapshotPath));
  await fs.writeFile(snapshotPath, JSON.stringify(data, null, 2));
}

async function loadSnapshot(snapshotPath: string): Promise<StyleSnapshot | null> {
  try {
    const raw = await fs.readFile(snapshotPath, "utf8");
    return JSON.parse(raw) as StyleSnapshot;
  } catch {
    return null;
  }
}

function diffStyles(expected: StyleSnapshot, received: StyleSnapshot): { ok: boolean; message?: string } {
  const changed: string[] = [];
  for (const target of Object.keys(expected.targets)) {
    const exp = expected.targets[target] as Record<string, unknown> | undefined;
    const rec = received.targets[target] as Record<string, unknown> | undefined;
    if (!exp || !rec) {
      changed.push(`${target}: missing target data`);
      continue;
    }
    if (exp.missing || rec.missing) {
      if (exp.missing !== rec.missing) {
        changed.push(`${target}: missing changed (${String(exp.missing)} -> ${String(rec.missing)})`);
      }
      continue;
    }
    const expComputed = (exp.computed as Record<string, string>) ?? {};
    const recComputed = (rec.computed as Record<string, string>) ?? {};
    for (const [prop, expValue] of Object.entries(expComputed)) {
      const recValue = recComputed[prop];
      if (recValue !== expValue) {
        changed.push(`${target}: ${prop} expected ${expValue} -> received ${recValue}`);
      }
    }
    const expPseudo = (exp.pseudo as Record<string, Record<string, string>>) ?? {};
    const recPseudo = (rec.pseudo as Record<string, Record<string, string>>) ?? {};
    for (const pseudoKey of Object.keys(expPseudo)) {
      const expMap = expPseudo[pseudoKey] ?? {};
      const recMap = recPseudo[pseudoKey] ?? {};
      for (const [prop, expValue] of Object.entries(expMap)) {
        const recValue = recMap[prop];
        if (recValue !== expValue) {
          changed.push(`${target}: ${pseudoKey} ${prop} expected ${expValue} -> received ${recValue}`);
        }
      }
    }
  }

  if (changed.length > 0) {
    return { ok: false, message: changed.slice(0, 12).join("\n") };
  }

  return { ok: true };
}

async function run(): Promise<void> {
  const fixtureFilter = getArg("--filter");
  const scenarioFilter = getArg("--scenario") ?? "S2_typical";

  const fixtures = getFixtures().filter((fixture) => (fixtureFilter ? fixture.id.includes(fixtureFilter) : true));
  const scenarios = (await loadScenarioFiles()).filter((scenario) => scenario.id.includes(scenarioFilter));

  if (fixtures.length === 0) {
    console.error("No fixtures matched filter.");
    process.exitCode = 1;
    return;
  }
  if (scenarios.length === 0) {
    console.error("No scenarios matched filter.");
    process.exitCode = 1;
    return;
  }

  const scenario = scenarios[0];

  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();

  let failures = 0;

  for (const fixture of fixtures) {
    if (!shouldRunScenario(fixture, scenario)) continue;

    const rawContent = await readFixtureFile(fixture.file);
    const split = splitMarkers(rawContent);
    const text = split ? split.text : rawContent;
    const chunks = isSplitScenario(scenario) && split ? split.chunks : buildChunks(text, scenario);

    await page.goto(`${BASE_URL}/regression/html/`, { waitUntil: "networkidle" });
    await page.waitForFunction(() => Boolean(window.__streammdxRegression));
    await page.evaluate(
      ({ fixtureId, scenarioId }) => window.__streammdxRegression?.setMeta({ fixtureId, scenarioId }),
      { fixtureId: fixture.id, scenarioId: scenario.id },
    );
    await page.evaluate(() => window.__streammdxRegression?.waitForReady());

    for (const chunk of chunks) {
      await page.evaluate((value) => window.__streammdxRegression?.appendAndFlush(value), chunk);
    }

    await page.evaluate(() => window.__streammdxRegression?.finalizeAndFlush());

    if (fixture.tags?.includes("mdx")) {
      try {
        await page.waitForFunction(() => {
          const summary = window.__streammdxRegression?.getSummary();
          if (!summary) return false;
          return summary.selectors.hasMdxCompiled && !summary.selectors.hasMdxPending;
        });
      } catch (error) {
        failures += 1;
        console.error(`\nMDX compile timeout for ${fixture.id}/${scenario.id}`);
        console.error(error);
      }
    }

    const targets = (await page.evaluate((targets) => window.__streammdxRegression?.getComputedStyles(targets), STYLE_TARGETS)) as Record<string, unknown>;

    const snapshot: StyleSnapshot = {
      fixtureId: fixture.id,
      fixtureTitle: fixture.title,
      scenarioId: scenario.id,
      scenario,
      targets,
    };

    const snapshotPath = path.join(SNAPSHOT_ROOT, `${fixture.id}.styles.snap.json`);

    if (UPDATE) {
      await writeSnapshot(snapshotPath, snapshot);
      console.log(`updated styles ${fixture.id}`);
      continue;
    }

    const expected = await loadSnapshot(snapshotPath);
    if (!expected) {
      console.error(`missing style snapshot for ${fixture.id}`);
      failures += 1;
      continue;
    }

    const result = diffStyles(expected, snapshot);
    if (!result.ok) {
      failures += 1;
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const artifactDir = path.join(ARTIFACT_ROOT, stamp, fixture.id, "styles");
      await ensureDir(artifactDir);
      await fs.writeFile(path.join(artifactDir, "expected.json"), JSON.stringify(expected, null, 2));
      await fs.writeFile(path.join(artifactDir, "received.json"), JSON.stringify(snapshot, null, 2));
      console.error(`\nStyle regression: ${fixture.id}\n${result.message}\n`);
      console.error(`artifacts: ${artifactDir}`);
    } else {
      console.log(`ok styles ${fixture.id}`);
    }
  }

  await page.close();
  await context.close();
  await browser.close();

  if (failures > 0) {
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
