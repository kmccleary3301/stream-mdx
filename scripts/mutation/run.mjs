#!/usr/bin/env node
// Usage: npm run mutation -- <target> [--concurrency=N] [--since=<git ref>]
// Runs pinned Stryker on one target from targets.mjs with the prewarmed-child runner: every test
// file of every mutant runs in its own fresh process whose module graph was loaded while earlier
// runs executed, and per-file coverage limits each mutant to the test files that reach it.
// --since=<ref> mutates only lines changed since <ref> (a feature's own diff) instead of whole files.
// Packages must be built first: other packages resolve to dist, except specifiers the target
// redirects to the mutated package's sandbox source.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { targets } from "./targets.mjs";

const STRYKER = "@stryker-mutator/core@9.6.1";
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");

const [name, ...flags] = process.argv.slice(2);
const target = targets[name];
if (!target) {
  console.error(`Unknown mutation target ${JSON.stringify(name)}. Targets: ${Object.keys(targets).join(", ")}`);
  process.exit(2);
}
const concurrencyFlag = flags.find((flag) => flag.startsWith("--concurrency="));
const concurrency = concurrencyFlag
  ? Number(concurrencyFlag.split("=")[1])
  : Math.max(1, Math.min(8, os.availableParallelism() - 2));

const packageDir = path.join(repoRoot, target.package);

/** Narrows `target.mutate` to `file:start-end` ranges of lines added or changed since `ref`. */
function changedRanges(ref) {
  const ranges = [];
  for (const file of target.mutate) {
    const diff = execFileSync("git", ["diff", "--unified=0", ref, "--", file], { cwd: packageDir, encoding: "utf8" });
    for (const match of diff.matchAll(/^@@ -\S+ \+(\d+)(?:,(\d+))? @@/gm)) {
      const start = Number(match[1]);
      const count = match[2] === undefined ? 1 : Number(match[2]);
      if (count > 0) ranges.push(`${file}:${start}-${start + count - 1}`);
    }
  }
  return ranges;
}

const sinceFlag = flags.find((flag) => flag.startsWith("--since="));
const mutate = sinceFlag ? changedRanges(sinceFlag.slice("--since=".length)) : target.mutate;
// Files Stryker instruments; the guard requires each to load from the instrumented sandbox copy.
const mutatedFiles = [...new Set(mutate.map((entry) => entry.replace(/:\d+-\d+$/, "")))];
if (mutate.length === 0) {
  console.log(`No changed lines in ${name}'s mutated files since ${sinceFlag.slice("--since=".length)}.`);
  process.exit(0);
}
const reportDir = path.join(repoRoot, "tmp", "mutation");
mkdirSync(reportDir, { recursive: true });

const configDir = mkdtempSync(path.join(os.tmpdir(), "stream-mdx-mutation-"));
const config = {
  plugins: [path.join(scriptDir, "hot-runner", "plugin.mjs")],
  testRunner: "stream-mdx-hot",
  streamMdxHot: {
    // Package-relative tests run from the sandbox copy; "packages/..." tests are other packages'
    // consumers, which reach the mutated source through `redirects`.
    testFiles: target.tests.map((file) => (file.startsWith("packages/") ? path.join(repoRoot, file) : file)),
    execArgv: [
      `--import=${pathToFileURL(path.join(repoRoot, "node_modules", "tsx", "dist", "loader.mjs")).href}`,
      `--import=${pathToFileURL(path.join(scriptDir, "instrumented-source-guard.mjs")).href}`,
    ],
    preloadFiles: mutatedFiles,
    preload: target.preload ?? [],
    timingsFile: path.join(configDir, "file-timings.json"),
    env: {
      NODE_COMPILE_CACHE: path.join(repoRoot, "node_modules", ".cache", "stream-mdx-mutation-compile"),
      STREAM_MDX_MUTATION_LIVE_PACKAGE: packageDir,
      STREAM_MDX_MUTATION_FILES: JSON.stringify(mutatedFiles),
      STREAM_MDX_MUTATION_REDIRECTS: JSON.stringify(target.redirects ?? {}),
    },
  },
  coverageAnalysis: "perTest",
  mutate,
  ignorePatterns: ["dist", ".stryker-*", "node_modules"],
  tempDirName: `.stryker-${name}`,
  cleanTempDir: true,
  concurrency,
  timeoutMS: 10_000,
  timeoutFactor: 1.5,
  // Mutant results are never reused: a test or source byte change must re-run every mutant.
  incremental: false,
  reporters: ["clear-text", "progress", "json"],
  jsonReporter: { fileName: path.join(reportDir, `${name}.json`) },
};

const configPath = path.join(configDir, `${name}.conf.json`);
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
try {
  const result = spawnSync("npx", ["--yes", "-p", STRYKER, "stryker", "run", configPath], { cwd: packageDir, stdio: "inherit" });
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(configDir, { recursive: true, force: true });
}
