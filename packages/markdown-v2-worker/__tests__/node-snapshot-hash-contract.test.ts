import assert from "node:assert";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compileMarkdownSnapshot, computeSnapshotHash } from "../src/node/index";

async function runHashContractTest(): Promise<void> {
  const text = ["# Hash Contract", "", "Same input should be stable."].join("\n");
  const initA = {
    docPlugins: { html: true, tables: true, footnotes: true, math: true },
    prewarmLangs: ["typescript", "bash"],
  };
  const initB = {
    // Same semantic config, different object key order.
    prewarmLangs: ["typescript", "bash"],
    docPlugins: { footnotes: true, math: true, tables: true, html: true },
  };

  const salt = "hash-contract-v1";
  const hashA = computeSnapshotHash(text, initA, salt);
  const hashB = computeSnapshotHash(text, initB, salt);
  assert.strictEqual(hashA, hashB, "hash should be stable regardless of init object key order");

  const hashDifferentText = computeSnapshotHash(`${text}\nextra`, initA, salt);
  assert.notStrictEqual(hashDifferentText, hashA, "hash should change when text changes");

  const hashDifferentSalt = computeSnapshotHash(text, initA, "hash-contract-v2");
  assert.notStrictEqual(hashDifferentSalt, hashA, "hash should change when salt changes");

  const [first, second] = await Promise.all([
    compileMarkdownSnapshot({
      text,
      init: initA,
      hashSalt: salt,
      workerOptions: {
        workerBundle: resolveTestWorkerBundle(),
      },
    }),
    compileMarkdownSnapshot({
      text,
      init: initA,
      hashSalt: salt,
      workerOptions: {
        workerBundle: resolveTestWorkerBundle(),
      },
    }),
  ]);

  assert.strictEqual(first.artifact.hash, second.artifact.hash, "artifact hash should be stable across runs");
  assert.strictEqual(first.artifact.contentHash, second.artifact.contentHash, "contentHash should be stable across runs");
  assert.strictEqual(first.artifact.configHash, second.artifact.configHash, "configHash should be stable across runs");
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

await runHashContractTest();
console.log("node snapshot hash contract test passed");
