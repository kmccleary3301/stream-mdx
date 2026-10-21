import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

// Each test file runs in its own Node process: a failure, an uncaught async error or leaked global
// state in one file cannot hide the results of the files after it.
const FILE_TIMEOUT_MS = Number(process.env.STREAM_MDX_TEST_FILE_TIMEOUT_MS ?? 300_000);

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

/** Resolves to undefined on success, otherwise a short failure reason. */
function runFile(filePath: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    // Node exits with code 13 when a test's top-level await never settles, so truncated files fail.
    const child = spawn(process.execPath, ["--import", "tsx", filePath], { stdio: "inherit" });
    const timer = setTimeout(() => child.kill("SIGKILL"), FILE_TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve(error.message);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      if (signal === "SIGKILL") resolve(`killed after ${FILE_TIMEOUT_MS} ms`);
      else if (signal) resolve(`signal ${signal}`);
      else resolve(code === 0 ? undefined : `exit ${code}`);
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

  console.log(`[stream-mdx] Running ${testFiles.length} test file(s) from ${formatRelative(testsDir)}...`);

  const failures: string[] = [];
  for (const filePath of testFiles) {
    const relative = formatRelative(filePath);
    console.log(`[stream-mdx] → ${relative}`);
    const failure = await runFile(filePath);
    if (failure) failures.push(`${relative} (${failure})`);
  }

  console.log(`[stream-mdx] ${testFiles.length - failures.length}/${testFiles.length} test file(s) passed.`);
  if (failures.length > 0) {
    console.error(`[stream-mdx] ${failures.length} failed:\n${failures.map((failure) => `  ${failure}`).join("\n")}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("[stream-mdx] tests failed:", err);
  process.exitCode = 1;
});
