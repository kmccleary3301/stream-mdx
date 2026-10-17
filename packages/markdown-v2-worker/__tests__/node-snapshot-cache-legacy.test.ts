import assert from "node:assert";
import { execSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { existsSync, promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";

import type { CompileMarkdownSnapshotOptions, SnapshotArtifactV1 } from "../src/node/index";
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
    const init = {
      docPlugins: { html: true, tables: true, footnotes: true },
      contentPolicy: "restricted",
      contentComponents: [{ name: "Badge", renderWhen: "closed" }],
      prewarmLangs: [],
      themes: { light: "min-light", dark: "nord" },
      syntax: [{ name: "ticket", pattern: { source: "#([A-Z]+-\\d+)" }, attrs: { id: 1 } }],
      html: { allowRaw: true, allowedTags: { kbd: [] }, literalTagContent: ["kbd"] },
    } satisfies NonNullable<CompileMarkdownSnapshotOptions["init"]>;
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

    // A matching v1 cache written before init metadata preservation must remain a hit.
    const cachedArtifact: SnapshotArtifactV1 = {
      ...result.artifact,
      createdAt: "2025-01-01T00:00:00.000Z",
      init: {
        docPlugins: init.docPlugins,
        prewarmLangs: init.prewarmLangs,
      },
    };
    await fs.writeFile(cachePath, JSON.stringify(cachedArtifact), "utf8");
    const cachedResult = await compileMarkdownSnapshot({
      text,
      init,
      hashSalt,
      cache: { dir: cacheDir, key, readOnly: true },
    });
    assert.strictEqual(cachedResult.fromCache, true, "matching v1 metadata repair must not recompile");
    assert.deepStrictEqual(cachedResult.artifact.init, result.artifact.init, "cache-hit and fresh artifacts must use the same public-init projection");
    assert.deepStrictEqual(JSON.parse(JSON.stringify(cachedResult.artifact)).init, init, "cache-hit artifact serialization must preserve every actual public init field");
    assert.strictEqual(cachedResult.artifact.hash, cachedArtifact.hash, "metadata repair must preserve the compile hash");
    assert.strictEqual(cachedResult.artifact.contentHash, cachedArtifact.contentHash, "metadata repair must preserve the content hash");
    assert.strictEqual(cachedResult.artifact.configHash, cachedArtifact.configHash, "metadata repair must preserve the config hash");
    assert.strictEqual(cachedResult.artifact.createdAt, cachedArtifact.createdAt, "metadata repair must preserve the cached creation time");
    assert.deepStrictEqual(cachedResult.blocks, result.blocks, "metadata repair must preserve cached content");
    assert.deepStrictEqual(JSON.parse(await fs.readFile(cachePath, "utf8")), JSON.parse(JSON.stringify(cachedArtifact)), "read-only cache hits must not rewrite the cached artifact");
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
