import fs from "node:fs/promises";
import path from "node:path";

import { compileMarkdownSnapshot } from "../packages/markdown-v2-worker/src/node/index.ts";

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  const get = (flag: string) => {
    const index = args.indexOf(flag);
    if (index === -1) return null;
    return args[index + 1] ?? null;
  };
  return {
    input: get("--input") ?? get("-i"),
    output: get("--output") ?? get("-o"),
    cacheDir: get("--cache-dir"),
  };
}

async function main() {
  const { input, output, cacheDir } = parseArgs(process.argv);
  if (!input) {
    throw new Error("Missing --input <path>");
  }

  const resolvedInput = path.resolve(input);
  const markdown = await fs.readFile(resolvedInput, "utf8");

  const result = await compileMarkdownSnapshot({
    text: markdown,
    init: {
      docPlugins: { tables: true, html: true, mdx: true, math: true, footnotes: true },
      mdx: { compileMode: "server" },
    },
    cache: cacheDir ? { dir: cacheDir } : undefined,
  });

  const outPath = path.resolve(output ?? `${resolvedInput}.snapshot.json`);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, JSON.stringify(result.artifact, null, 2), "utf8");

  process.stdout.write(`[stream-mdx] Wrote snapshot: ${outPath}\n`);
}

main().catch((err) => {
  console.error("[stream-mdx] compile-markdown-snapshot failed:", err);
  process.exitCode = 1;
});
