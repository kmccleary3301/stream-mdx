import assert from "node:assert";
import { execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { existsSync, promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";

import { compileMarkdownSnapshot, computeSnapshotHash } from "../src/node/index";

async function readJsonEventually<T>(filePath: string, predicate: (value: unknown) => value is T, timeoutMs = 2000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      if (!raw.trim()) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        continue;
      }
      const parsed = JSON.parse(raw);
      if (!predicate(parsed)) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        continue;
      }
      return parsed;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("timed out waiting for snapshot cache file");
}

async function runLegacyCacheCompatibilityTest(): Promise<void> {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "stream-mdx-legacy-cache-"));
  try {
    const text = ["# Title", "", "body"].join("\n");
    const init = { docPlugins: { html: true, tables: true, footnotes: true }, prewarmLangs: [] };
    const hashSalt = "legacy-cache-compat";
    const key = "legacy-cache-key";
    const hash = computeSnapshotHash(text, init, hashSalt);
    const cachePath = path.join(cacheDir, `${key}.json`);

    // Simulate an old schema payload that should be treated as a miss and regenerated.
    await fs.writeFile(
      cachePath,
      JSON.stringify(
        {
          version: 0,
          hash,
          createdAt: "2025-01-01T00:00:00.000Z",
          blocks: [],
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await compileMarkdownSnapshot({
      text,
      init,
      hashSalt,
      workerOptions: {
        workerBundle: resolveTestWorkerBundle(),
      },
      cache: {
        dir: cacheDir,
        key,
      },
    });

    assert.strictEqual(result.fromCache, false, "legacy schema cache should be a miss");

    const parsed = await readJsonEventually(
      cachePath,
      (value): value is { version?: number; schemaId?: string; hash?: string; blocks?: unknown[] } =>
        Boolean(value && typeof value === "object" && (value as { version?: number }).version === 1),
    );
    assert.strictEqual(parsed.version, 1, "cache should be rewritten to v1");
    assert.strictEqual(parsed.schemaId, "streammdx.snapshot.v1", "cache should include the current schema id");
    assert.strictEqual(parsed.hash, hash, "rewritten cache should preserve compile hash");
    assert.ok(Array.isArray(parsed.blocks) && parsed.blocks.length > 0, "rewritten cache should include compiled blocks");
  } finally {
    await fs.rm(cacheDir, { recursive: true, force: true });
  }
}

function resolveTestWorkerBundle(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const pkgRoot = path.resolve(here, "..");
  const hostedPath = path.join(pkgRoot, "dist/hosted/markdown-worker.js");
  if (!existsSync(hostedPath)) {
    execSync("npm run build:hosted", { cwd: pkgRoot, stdio: "inherit" });
  }
  return hostedPath;
}

await runLegacyCacheCompatibilityTest();
console.log("node snapshot cache legacy compatibility test passed");
