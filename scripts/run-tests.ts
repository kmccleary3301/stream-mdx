import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

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

// Run test files separately because they may share process-global test harness state.
async function runTestFile(filePath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [...process.execArgv, filePath], {
      stdio: "inherit",
      cwd: process.cwd(),
      env: process.env,
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${formatRelative(filePath)} exited due to signal ${signal}.`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`${formatRelative(filePath)} exited with code ${code}.`));
        return;
      }
      resolve();
    });
  });
}

// Keep async runner work from becoming a false green if the event loop drains before main settles.
let runningFile: string | null = null;
let finished = false;

process.on("exit", () => {
  if (finished) {
    return;
  }
  console.error(`[stream-mdx] tests failed: process exited before ${runningFile ?? "test discovery"} settled (unresolved async work).`);
  process.exitCode = 1;
});

async function main() {
  const testsDirArg = process.argv[2] ?? "__tests__";
  const testsDir = path.resolve(process.cwd(), testsDirArg);

  const testFiles = (await collectTestFiles(testsDir)).sort((a, b) => a.localeCompare(b));
  if (testFiles.length === 0) {
    throw new Error(`No test files found under ${formatRelative(testsDir)}.`);
  }

  console.log(`[stream-mdx] Running ${testFiles.length} test file(s) from ${formatRelative(testsDir)}...`);

  for (const filePath of testFiles) {
    runningFile = formatRelative(filePath);
    console.log(`[stream-mdx] → ${runningFile}`);
    await runTestFile(filePath);
  }
}

main()
  .catch((err) => {
    console.error("[stream-mdx] tests failed:", err);
    process.exitCode = 1;
  })
  .finally(() => {
    finished = true;
  });

