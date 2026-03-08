import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

import { compileMarkdownSnapshotDirect } from "../src/direct-compile";

type CacheArtifact = {
  version?: number;
  schemaId?: string;
  hash?: string;
  blocks?: unknown[];
};

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

async function runDirectSnapshotCacheTest(): Promise<void> {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "stream-mdx-direct-cache-"));
  try {
    const text = ["# Direct cache", "", "cached block output"].join("\n");
    const init = { docPlugins: { html: true, tables: true, footnotes: true, math: true }, prewarmLangs: ["typescript"] };
    const hashSalt = "direct-cache-contract";
    const key = "direct-cache-key";
    const cachePath = path.join(cacheDir, `${key}.json`);

    const first = await compileMarkdownSnapshotDirect({
      text,
      init,
      hashSalt,
      cache: {
        dir: cacheDir,
        key,
      },
    });
    assert.strictEqual(first.fromCache, false, "first direct compile should miss cache");

    const cachedFirst = await readJsonEventually(
      cachePath,
      (value): value is CacheArtifact => Boolean(value && typeof value === "object" && (value as CacheArtifact).version === 1),
    );
    assert.strictEqual(cachedFirst.version, 1, "cache should be written as schema v1");
    assert.strictEqual(cachedFirst.schemaId, "streammdx.snapshot.v1", "cache should include schema id");
    assert.ok(Array.isArray(cachedFirst.blocks) && cachedFirst.blocks.length > 0, "cache should include compiled blocks");

    const second = await compileMarkdownSnapshotDirect({
      text,
      init,
      hashSalt,
      cache: {
        dir: cacheDir,
        key,
      },
    });
    assert.strictEqual(second.fromCache, true, "second direct compile should hit cache");
    assert.deepStrictEqual(second.blocks, first.blocks, "cache hit should return identical blocks");

    await fs.writeFile(
      cachePath,
      JSON.stringify(
        {
          version: 0,
          hash: first.artifact.hash,
          createdAt: "2025-01-01T00:00:00.000Z",
          blocks: [],
        },
        null,
        2,
      ),
      "utf8",
    );

    const legacyRegenerated = await compileMarkdownSnapshotDirect({
      text,
      init,
      hashSalt,
      cache: {
        dir: cacheDir,
        key,
      },
    });
    assert.strictEqual(legacyRegenerated.fromCache, false, "legacy cache schema should be treated as miss");
    const cachedRegenerated = await readJsonEventually(
      cachePath,
      (value): value is CacheArtifact => Boolean(value && typeof value === "object" && (value as CacheArtifact).version === 1),
    );
    assert.strictEqual(cachedRegenerated.version, 1, "legacy payload should be rewritten to v1");
    assert.strictEqual(cachedRegenerated.hash, legacyRegenerated.artifact.hash, "rewritten cache should preserve current hash");

    const readOnlyKey = "direct-cache-read-only";
    const readOnlyPath = path.join(cacheDir, `${readOnlyKey}.json`);
    const readOnlyMiss = await compileMarkdownSnapshotDirect({
      text,
      init,
      hashSalt: `${hashSalt}-readonly`,
      cache: {
        dir: cacheDir,
        key: readOnlyKey,
        readOnly: true,
      },
    });
    assert.strictEqual(readOnlyMiss.fromCache, false, "read-only miss should compile in memory");
    const readOnlyExists = await fs
      .access(readOnlyPath)
      .then(() => true)
      .catch(() => false);
    assert.strictEqual(readOnlyExists, false, "read-only cache should not write new file");

    await compileMarkdownSnapshotDirect({
      text,
      init,
      hashSalt: `${hashSalt}-readonly-hit`,
      cache: {
        dir: cacheDir,
        key: readOnlyKey,
      },
    });
    const readOnlyHit = await compileMarkdownSnapshotDirect({
      text,
      init,
      hashSalt: `${hashSalt}-readonly-hit`,
      cache: {
        dir: cacheDir,
        key: readOnlyKey,
        readOnly: true,
      },
    });
    assert.strictEqual(readOnlyHit.fromCache, true, "read-only mode should still read cache hits");
  } finally {
    await fs.rm(cacheDir, { recursive: true, force: true });
  }
}

await runDirectSnapshotCacheTest();
console.log("direct snapshot cache test passed");

