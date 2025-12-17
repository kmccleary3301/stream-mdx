import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function run(command: string, args: string[], options: { cwd: string }) {
  execFileSync(command, args, {
    cwd: options.cwd,
    stdio: "inherit",
    env: {
      ...process.env,
      npm_config_loglevel: process.env.npm_config_loglevel ?? "warn",
    },
  });
}

function findSinglePack(packsDir: string, predicate: (name: string) => boolean): string {
  const matches = fs
    .readdirSync(packsDir)
    .filter((name) => name.endsWith(".tgz"))
    .filter((name) => predicate(name));
  if (matches.length !== 1) {
    throw new Error(`Expected exactly 1 pack match, found ${matches.length}: ${matches.join(", ")}`);
  }
  return path.join(packsDir, matches[0]);
}

function copyDir(src: string, dest: string) {
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (entry) => {
      const base = path.basename(entry);
      return base !== "node_modules" && base !== ".next" && base !== "dist" && base !== ".turbo";
    },
  });
}

function rewriteNextPackageJson(options: {
  pkgPath: string;
  streamMdxTarball: string;
  scopedTarballs: Record<string, string>;
}) {
  const raw = fs.readFileSync(options.pkgPath, "utf8");
  const parsed = JSON.parse(raw) as {
    dependencies?: Record<string, string>;
    overrides?: Record<string, string>;
  };

  parsed.dependencies = parsed.dependencies ?? {};
  parsed.dependencies["stream-mdx"] = `file:${options.streamMdxTarball}`;
  delete parsed.dependencies["@stream-mdx/core"];
  delete parsed.dependencies["@stream-mdx/plugins"];
  delete parsed.dependencies["@stream-mdx/worker"];
  delete parsed.dependencies["@stream-mdx/react"];

  parsed.overrides = parsed.overrides ?? {};
  for (const [name, tarball] of Object.entries(options.scopedTarballs)) {
    parsed.overrides[name] = `file:${tarball}`;
  }

  fs.writeFileSync(options.pkgPath, `${JSON.stringify(parsed, null, 2)}\n`);
}

function main() {
  const repoRoot = path.resolve(__dirname, "..");
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "stream-mdx-pack-smoke-"));
  const packsDir = path.join(tmpRoot, "packs");
  const nextDir = path.join(tmpRoot, "next");
  fs.mkdirSync(packsDir, { recursive: true });

  console.log(`[pack-smoke] tmp: ${tmpRoot}`);

  run("npm", ["-w", "@stream-mdx/core", "pack", "--pack-destination", packsDir], { cwd: repoRoot });
  run("npm", ["-w", "@stream-mdx/plugins", "pack", "--pack-destination", packsDir], { cwd: repoRoot });
  run("npm", ["-w", "@stream-mdx/worker", "pack", "--pack-destination", packsDir], { cwd: repoRoot });
  run("npm", ["-w", "@stream-mdx/react", "pack", "--pack-destination", packsDir], { cwd: repoRoot });
  run("npm", ["-w", "stream-mdx", "pack", "--pack-destination", packsDir], { cwd: repoRoot });

  const tarStream = findSinglePack(packsDir, (name) => /^stream-mdx-\d/.test(name));
  const tarCore = findSinglePack(packsDir, (name) => name.startsWith("stream-mdx-core-"));
  const tarPlugins = findSinglePack(packsDir, (name) => name.startsWith("stream-mdx-plugins-"));
  const tarWorker = findSinglePack(packsDir, (name) => name.startsWith("stream-mdx-worker-"));
  const tarReact = findSinglePack(packsDir, (name) => name.startsWith("stream-mdx-react-"));

  copyDir(path.join(repoRoot, "examples", "streaming-markdown-starter"), nextDir);

  rewriteNextPackageJson({
    pkgPath: path.join(nextDir, "package.json"),
    streamMdxTarball: tarStream,
    scopedTarballs: {
      "@stream-mdx/core": tarCore,
      "@stream-mdx/plugins": tarPlugins,
      "@stream-mdx/worker": tarWorker,
      "@stream-mdx/react": tarReact,
    },
  });

  run("npm", ["install", "--no-fund", "--no-audit"], { cwd: nextDir });
  run("npm", ["run", "build"], { cwd: nextDir });

  if (process.env.KEEP_PACK_SMOKE_TMP !== "1") {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } else {
    console.log(`[pack-smoke] KEEP_PACK_SMOKE_TMP=1, leaving ${tmpRoot}`);
  }
}

main();

