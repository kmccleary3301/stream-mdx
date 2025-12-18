import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

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

async function main() {
  const testsDirArg = process.argv[2] ?? "__tests__";
  const testsDir = path.resolve(process.cwd(), testsDirArg);

  const testFiles = (await collectTestFiles(testsDir)).sort((a, b) => a.localeCompare(b));
  if (testFiles.length === 0) {
    throw new Error(`No test files found under ${formatRelative(testsDir)}.`);
  }

  console.log(`[stream-mdx] Running ${testFiles.length} test file(s) from ${formatRelative(testsDir)}...`);

  for (const filePath of testFiles) {
    console.log(`[stream-mdx] → ${formatRelative(filePath)}`);
    await import(pathToFileURL(filePath).href);
  }
}

main().catch((err) => {
  console.error("[stream-mdx] tests failed:", err);
  process.exitCode = 1;
});

