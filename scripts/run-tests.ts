import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Each test file runs in its own Node process: a failure, an uncaught async error or leaked global
// state in one file cannot hide the results of the files after it. Files run concurrently up to
// STREAM_MDX_TEST_CONCURRENCY (1 restores serial execution); each file's output is buffered and
// printed whole when it finishes, so logs never interleave.
const FILE_TIMEOUT_MS = Number(process.env.STREAM_MDX_TEST_FILE_TIMEOUT_MS ?? 300_000);
const CONCURRENCY = Math.max(
  1,
  Number(process.env.STREAM_MDX_TEST_CONCURRENCY ?? Math.min(4, Math.max(1, os.availableParallelism() - 1))),
);

async function collectTestFiles(dirPath: string): Promise<string[]> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectTestFiles(entryPath)));
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx") || entry.name.endsWith(".test.mts")) {
      files.push(entryPath);
    }
  }

  return files;
}

function formatRelative(filePath: string) {
  const rel = path.relative(process.cwd(), filePath);
  return rel.length === 0 ? filePath : rel;
}

interface FileResult {
  readonly failure: string | undefined;
  readonly output: string;
  readonly ms: number;
}

function runFile(filePath: string): Promise<FileResult> {
  const started = performance.now();
  return new Promise((resolve) => {
    // Children reuse this runner's tsx loader flags. Node exits with code 13 when a test's top-level
    // await never settles, so truncated files fail.
    const child = spawn(process.execPath, [...process.execArgv, filePath], { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), FILE_TIMEOUT_MS);
    const settle = (failure: string | undefined) => {
      clearTimeout(timer);
      resolve({ failure, output: Buffer.concat(chunks).toString("utf8"), ms: performance.now() - started });
    };
    child.on("error", (error) => settle(error.message));
    child.on("close", (code, signal) => {
      if (signal === "SIGKILL") settle(`killed after ${FILE_TIMEOUT_MS} ms`);
      else if (signal) settle(`signal ${signal}`);
      else settle(code === 0 ? undefined : `exit ${code}`);
    });
  });
}

async function main() {
  const testsDirArg = process.argv[2] ?? "__tests__";
  const testsDir = path.resolve(process.cwd(), testsDirArg);

  const testFiles = (await collectTestFiles(testsDir)).sort((a, b) => a.localeCompare(b));
  if (testFiles.length === 0) {
    throw new Error(`No test files found under ${formatRelative(testsDir)}.`);
  }

  console.log(
    `[stream-mdx] Running ${testFiles.length} test file(s) from ${formatRelative(testsDir)} with concurrency ${CONCURRENCY}...`,
  );

  const failures: string[] = [];
  let next = 0;
  const worker = async () => {
    while (next < testFiles.length) {
      const filePath = testFiles[next];
      next += 1;
      const relative = formatRelative(filePath);
      const result = await runFile(filePath);
      const seconds = (result.ms / 1000).toFixed(2);
      if (result.failure) {
        failures.push(`${relative} (${result.failure})`);
        console.log(`[stream-mdx] ✗ ${relative} ${seconds}s\n${result.output}`);
      } else {
        console.log(`[stream-mdx] ✓ ${relative} ${seconds}s`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, testFiles.length) }, worker));

  console.log(`[stream-mdx] ${testFiles.length - failures.length}/${testFiles.length} test file(s) passed.`);
  if (failures.length > 0) {
    failures.sort((a, b) => a.localeCompare(b));
    console.error(`[stream-mdx] ${failures.length} failed:\n${failures.map((failure) => `  ${failure}`).join("\n")}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("[stream-mdx] tests failed:", err);
  process.exitCode = 1;
});
