import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

function getArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return undefined;
  const next = process.argv[idx + 1];
  return next && !next.startsWith("--") ? next : undefined;
}

const repoRoot = resolve(__dirname, "..");
const source = resolve(repoRoot, "packages/markdown-v2-worker/dist/hosted/markdown-worker.js");
const dest = resolve(
  repoRoot,
  getArg("--to") ?? "examples/streaming-markdown-starter/public/workers/markdown-worker.js",
);

mkdirSync(dirname(dest), { recursive: true });
copyFileSync(source, dest);

console.log(`[stream-mdx] Copied hosted worker:\n- from: ${source}\n- to:   ${dest}`);


