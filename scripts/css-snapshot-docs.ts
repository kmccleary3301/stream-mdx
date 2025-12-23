import fs from "node:fs/promises";
import path from "node:path";
import { execSync } from "node:child_process";

function parseArgs(argv: string[]) {
  const args = new Set(argv.slice(2));
  return {
    runBuild: args.has("--build"),
  };
}

async function fileExists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function getGitShaShort(repoRoot: string) {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: repoRoot, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "unknown";
  }
}

async function main() {
  const repoRoot = path.resolve(__dirname, "..");
  const docsOutRoot = path.resolve(repoRoot, "apps/docs/out/_next/static/css");
  const tmpRoot = path.resolve(repoRoot, "tmp/css-snapshots");
  const { runBuild } = parseArgs(process.argv);

  if (runBuild) {
    execSync("npm run docs:build", { cwd: repoRoot, stdio: "inherit" });
  }

  if (!(await fileExists(docsOutRoot))) {
    throw new Error(`Missing docs build output at ${docsOutRoot}. Run: npm run docs:build`);
  }

  const files = (await fs.readdir(docsOutRoot))
    .filter((name) => name.endsWith(".css"))
    .sort((a, b) => a.localeCompare(b));

  if (files.length === 0) {
    throw new Error(`No CSS files found in ${docsOutRoot}.`);
  }

  const chunks: string[] = [];
  for (const name of files) {
    const filePath = path.resolve(docsOutRoot, name);
    const css = await fs.readFile(filePath, "utf8");
    chunks.push(`/* --- ${name} --- */\n${css}\n`);
  }

  await fs.mkdir(tmpRoot, { recursive: true });
  const sha = getGitShaShort(repoRoot);
  const outPath = path.resolve(tmpRoot, `docs-${sha}.css`);
  await fs.writeFile(outPath, chunks.join("\n"), "utf8");

  process.stdout.write(`[stream-mdx] Wrote CSS snapshot: ${path.relative(repoRoot, outPath)}\n`);
}

main().catch((err) => {
  console.error("[stream-mdx] css-snapshot-docs failed:", err);
  process.exitCode = 1;
});

