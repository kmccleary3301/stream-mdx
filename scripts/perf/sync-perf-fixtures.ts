import path from "node:path";
import fs from "node:fs/promises";

const ROOT = process.cwd();
const FIXTURE_SRC = path.join(ROOT, "tests/regression/fixtures");
const SCENARIO_SRC = path.join(ROOT, "tests/regression/scenarios");
const FIXTURE_DEST = path.join(ROOT, "apps/docs/public/perf/fixtures");
const SCENARIO_DEST = path.join(ROOT, "apps/docs/public/perf/scenarios");

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

async function listFiles(dir: string, ext: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith(ext)).map((entry) => entry.name);
}

async function clearDir(dir: string, ext: string): Promise<void> {
  const files = await listFiles(dir, ext);
  await Promise.all(files.map((file) => fs.unlink(path.join(dir, file))));
}

async function copyFiles(src: string, dest: string, ext: string): Promise<void> {
  const files = await listFiles(src, ext);
  await Promise.all(
    files.map((file) => fs.copyFile(path.join(src, file), path.join(dest, file))),
  );
}

async function run(): Promise<void> {
  await ensureDir(FIXTURE_DEST);
  await ensureDir(SCENARIO_DEST);

  await clearDir(FIXTURE_DEST, ".md");
  await clearDir(SCENARIO_DEST, ".json");

  await copyFiles(FIXTURE_SRC, FIXTURE_DEST, ".md");
  await copyFiles(SCENARIO_SRC, SCENARIO_DEST, ".json");

  console.log("perf fixtures synced to apps/docs/public/perf");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
