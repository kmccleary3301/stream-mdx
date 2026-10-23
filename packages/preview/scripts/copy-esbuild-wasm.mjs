import { copyFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const compilerEntry = require.resolve("esbuild-wasm");
const wasmPath = resolve(dirname(compilerEntry), "../esbuild.wasm");
copyFileSync(wasmPath, join(packageRoot, "dist", "esbuild.wasm"));
