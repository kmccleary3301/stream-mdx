import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "@playwright/test";
import { CAMPAIGN_OBSERVATIONS } from "./campaign-portfolio";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ASSET_DIR = join(ROOT, "apps/docs/out/stream-mdx-progress-observation");
const OBSERVATION_URL = "http://127.0.0.1:3012/stream-mdx-progress-observation/";
const OUTPUT_FILE = join(ROOT, "tmp/stream-mdx-progress-observation-20261015.json");
const READY_TIMEOUT_MS = 30_000;
const OBSERVATION_TIMEOUT_MS = 60_000;
const EXPECTED_PLAYWRIGHT_VERSION = "1.58.2";
const EXPECTED_CHROMIUM_VERSION = "153.0.8010.12";

interface ObservationWindow extends Window {
  __streamMdxProgressObservationReady?: boolean;
  __streamMdxProgressObservationReport?: unknown;
}

interface DriverEvidence {
  schemaVersion: 1;
  status: "complete" | "error";
  startedAt: string;
  completedAt: string;
  durationMs: number;
  measurementKind: "instrumented-functional-not-comparable-timing";
  deadlines: {
    readinessMs: number;
    observationMs: number;
    readinessDeadlineAt: string | null;
    observationDeadlineAt: string | null;
  };
  identity: {
    observationId: string;
    fixtureSha256: string;
    computedFixtureSha256: string;
    traceSha256: string;
    computedTraceSha256: string;
    fixtureUnitsUTF16: number;
    traceChunkCount: number;
    scenario: typeof CAMPAIGN_OBSERVATIONS["code-262k"]["scenario"];
  };
  artifacts: {
    outputDirectory: string;
    browserEntry: string;
    workerEntry: string;
    workerEngineSource: string;
    sourceAliases: string[];
    browserNodeEnv: "production";
    workerCountersEnabled: true;
    sha256: Record<string, string>;
  };
  browser: {
    playwrightVersion: string | null;
    expectedPlaywrightVersion: string;
    chromiumVersion: string | null;
    expectedChromiumVersion: string;
    headless: true;
    headlessShell: true;
  };
  pageReport: unknown;
  runtimeErrors: {
    console: string[];
    page: string[];
    requests: string[];
  };
  errors: string[];
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function remainingMs(deadline: number, label: string): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error(`${label} deadline exceeded.`);
  return remaining;
}

async function readPageReport(page: Page): Promise<unknown> {
  try {
    return await page.evaluate(() => (window as ObservationWindow).__streamMdxProgressObservationReport ?? null);
  } catch {
    return null;
  }
}

async function readArtifactHashes(): Promise<Record<string, string>> {
  const files = {
    html: join(ASSET_DIR, "index.html"),
    browserBundle: join(ASSET_DIR, "browser.js"),
    workerBundle: join(ASSET_DIR, "worker.js"),
  };
  const hashes: Record<string, string> = {};
  for (const [name, path] of Object.entries(files)) {
    hashes[name] = sha256(await readFile(path));
  }
  return hashes;
}

async function runObservation(): Promise<void> {
  const startedAt = new Date().toISOString();
  const startedAtMs = Date.now();
  const readinessDeadline = startedAtMs + READY_TIMEOUT_MS;
  const readinessDeadlineAt = new Date(readinessDeadline).toISOString();
  const campaign = CAMPAIGN_OBSERVATIONS["code-262k"];
  const fixture = campaign.getFixture();
  const trace = campaign.getTrace();
  const computedFixtureSha256 = sha256(fixture);
  const computedTraceSha256 = sha256(JSON.stringify(trace));
  const errors: string[] = [];
  const runtimeErrors = { console: [] as string[], page: [] as string[], requests: [] as string[] };
  const artifactHashes: Record<string, string> = {};
  let playwrightVersion: string | null = null;
  let chromiumVersion: string | null = null;
  let observationDeadlineAt: string | null = null;
  let pageReport: unknown = null;
  let browser: Browser | null = null;
  let page: Page | null = null;
  let ready = false;

  if (computedFixtureSha256 !== campaign.fixtureHash) errors.push("Campaign fixture SHA-256 differs from its frozen identity.");
  if (computedTraceSha256 !== campaign.traceHash) errors.push("Campaign trace SHA-256 differs from its frozen identity.");
  if (fixture.length !== campaign.targetUnits || trace.length !== campaign.chunkCount) {
    errors.push("Campaign fixture length or trace ordinal count differs from its frozen identity.");
  }

  try {
    Object.assign(artifactHashes, await readArtifactHashes());
  } catch (error) {
    errors.push(`Unable to read test-owned observation assets: ${errorMessage(error)}`);
  }

  try {
    const packageMetadata = JSON.parse(await readFile(join(ROOT, "node_modules/playwright/package.json"), "utf8")) as { version?: string };
    playwrightVersion = packageMetadata.version ?? null;
  } catch (error) {
    errors.push(`Unable to identify the installed Playwright package: ${errorMessage(error)}`);
  }
  if (playwrightVersion !== EXPECTED_PLAYWRIGHT_VERSION) {
    errors.push(`Expected Playwright ${EXPECTED_PLAYWRIGHT_VERSION}; observed ${playwrightVersion ?? "unavailable"}.`);
  }
  if (errors.length === 0) {
    try {
      browser = await chromium.launch({ headless: true });
      chromiumVersion = browser.version();
      if (chromiumVersion !== EXPECTED_CHROMIUM_VERSION) {
        errors.push(`Expected Chromium ${EXPECTED_CHROMIUM_VERSION}; observed ${chromiumVersion}.`);
      } else {
        page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
        page.on("console", (message) => {
          if (message.type() === "error") runtimeErrors.console.push(message.text());
        });
        page.on("pageerror", (error) => runtimeErrors.page.push(error.message));
        page.on("requestfailed", (request) => {
          runtimeErrors.requests.push(`${request.method()} ${request.url()} (${request.failure()?.errorText ?? "unknown failure"})`);
        });

        await page.goto(OBSERVATION_URL, {
          waitUntil: "domcontentloaded",
          timeout: remainingMs(readinessDeadline, "Readiness"),
        });
        await page.waitForFunction(
          () => {
            const observationWindow = window as ObservationWindow;
            const report = observationWindow.__streamMdxProgressObservationReport as { status?: unknown } | undefined;
            return observationWindow.__streamMdxProgressObservationReady === true || report?.status === "error";
          },
          null,
          { timeout: remainingMs(readinessDeadline, "Readiness") },
        );
        ready = await page.evaluate(() => (window as ObservationWindow).__streamMdxProgressObservationReady === true);
        pageReport = await readPageReport(page);

        if (ready) {
          const observationDeadline = startedAtMs + OBSERVATION_TIMEOUT_MS;
          observationDeadlineAt = new Date(observationDeadline).toISOString();
          await page.waitForFunction(
            () => {
              const report = (window as ObservationWindow).__streamMdxProgressObservationReport as { status?: unknown } | undefined;
              return report?.status === "complete" || report?.status === "error";
            },
            null,
            { timeout: remainingMs(observationDeadline, "Observation") },
          );
          pageReport = await readPageReport(page);
        } else {
          errors.push("Browser observation reported an error before readiness.");
        }
      }
    } catch (error) {
      errors.push(errorMessage(error));
      if (page) pageReport = await readPageReport(page);
    }
  }

  if (page) pageReport = await readPageReport(page);
  if (browser) {
    try {
      await browser.close();
    } catch (error) {
      errors.push(`Unable to close Playwright browser cleanly: ${errorMessage(error)}`);
    }
  }
  if (runtimeErrors.console.length > 0) errors.push("Browser emitted console errors.");
  if (runtimeErrors.page.length > 0) errors.push("Browser emitted page errors.");
  if (runtimeErrors.requests.length > 0) errors.push("Browser requests failed.");

  const completedAt = new Date().toISOString();
  const pageComplete =
    typeof pageReport === "object" &&
    pageReport !== null &&
    "status" in pageReport &&
    pageReport.status === "complete";
  if (!pageComplete && pageReport !== null) errors.push("Browser observation did not reach complete status.");
  const evidence: DriverEvidence = {
    schemaVersion: 1,
    status: errors.length === 0 && pageComplete ? "complete" : "error",
    startedAt,
    completedAt,
    durationMs: Date.now() - startedAtMs,
    measurementKind: "instrumented-functional-not-comparable-timing",
    deadlines: {
      readinessMs: READY_TIMEOUT_MS,
      observationMs: OBSERVATION_TIMEOUT_MS,
      readinessDeadlineAt,
      observationDeadlineAt,
    },
    identity: {
      observationId: campaign.id,
      fixtureSha256: campaign.fixtureHash,
      computedFixtureSha256,
      traceSha256: campaign.traceHash,
      computedTraceSha256,
      fixtureUnitsUTF16: fixture.length,
      traceChunkCount: trace.length,
      scenario: campaign.scenario,
    },
    artifacts: {
      outputDirectory: ASSET_DIR,
      browserEntry: "scripts/perf/progress-observation-browser.ts",
      workerEntry: "scripts/perf/progress-observation-worker.ts",
      workerEngineSource: "packages/markdown-v2-worker/src/engine/engine.ts",
      sourceAliases: [
        "@stream-mdx/core -> packages/markdown-v2-core/src",
        "@stream-mdx/plugins -> packages/markdown-v2-plugins/src",
        "@stream-mdx/react -> packages/markdown-v2-react/src",
        "@stream-mdx/worker -> packages/markdown-v2-worker/src",
      ],
      browserNodeEnv: "production",
      workerCountersEnabled: true,
      sha256: artifactHashes,
    },
    browser: {
      playwrightVersion,
      expectedPlaywrightVersion: EXPECTED_PLAYWRIGHT_VERSION,
      chromiumVersion,
      expectedChromiumVersion: EXPECTED_CHROMIUM_VERSION,
      headless: true,
      headlessShell: true,
    },
    pageReport,
    runtimeErrors,
    errors,
  };

  await mkdir(dirname(OUTPUT_FILE), { recursive: true });
  await writeFile(OUTPUT_FILE, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(`Progress observation evidence written to ${OUTPUT_FILE}`);
  if (evidence.status !== "complete") process.exitCode = 1;
}

void runObservation().catch(async (error: unknown) => {
  const failedEvidence = {
    schemaVersion: 1,
    status: "error",
    completedAt: new Date().toISOString(),
    errors: [`Progress observation driver failed: ${errorMessage(error)}`],
    pageReport: null,
  };
  await mkdir(dirname(OUTPUT_FILE), { recursive: true });
  await writeFile(OUTPUT_FILE, `${JSON.stringify(failedEvidence, null, 2)}\n`, "utf8");
  console.error(`Progress observation failed; partial evidence written to ${OUTPUT_FILE}`);
  process.exitCode = 1;
});
