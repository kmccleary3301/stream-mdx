import assert from "node:assert";
import { execSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

async function runServerEntryIsolationTest(): Promise<void> {
  const testFile = fileURLToPath(import.meta.url);
  const pkgRoot = path.resolve(path.dirname(testFile), "..");
  const distServerPath = path.join(pkgRoot, "dist", "server.mjs");

  execSync("npm run build", { cwd: pkgRoot, stdio: "inherit" });
  const source = await fs.readFile(distServerPath, "utf8");

  assert.ok(!source.includes('"use client"'), "server entry must not be emitted as a client module");
  assert.ok(!source.includes("streaming-markdown"), "server entry must not import client streaming entry");
  assert.ok(source.includes("blocks-renderer"), "server entry should reference server renderer path");
}

await runServerEntryIsolationTest();
console.log("server entry isolation test passed");
