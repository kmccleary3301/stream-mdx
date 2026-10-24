import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

async function runServerEntryIsolationTest(): Promise<void> {
  const testFile = fileURLToPath(import.meta.url);
  const pkgRoot = path.resolve(path.dirname(testFile), "..");
  // Build into a private directory: the shared dist/ is read concurrently by other suites.
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "stream-mdx-server-entry-"));
  try {
    execFileSync("npx", ["tsup", "--out-dir", outDir, "--no-dts"], { cwd: pkgRoot, stdio: "pipe" });
    const source = await fs.readFile(path.join(outDir, "server.mjs"), "utf8");

    assert.ok(!source.includes('"use client"'), "server entry must not be emitted as a client module");
    assert.ok(!source.includes("streaming-markdown"), "server entry must not import client streaming entry");
    assert.ok(source.includes("blocks-renderer"), "server entry should reference server renderer path");
  } finally {
    await fs.rm(outDir, { recursive: true, force: true });
  }
}

await runServerEntryIsolationTest();
console.log("server entry isolation test passed");
