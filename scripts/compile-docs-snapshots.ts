#!/usr/bin/env tsx

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { DOC_SECTIONS } from "../apps/docs/lib/docs";
import { GUIDE_ITEMS } from "../apps/docs/content/guides";
import { compileMarkdownSnapshot, type SnapshotArtifactV1 } from "../packages/markdown-v2-worker/src/node/index.ts";

type SnapshotKind = "docs" | "guides";

type SnapshotEntry = {
  kind: SnapshotKind;
  slug: string;
  sourcePath: string;
  outputPath: string;
  hash: string;
  blockCount: number;
  fromCache: boolean;
  reusedArtifact: boolean;
};

type SnapshotManifest = {
  version: 1;
  generatedAt: string;
  counts: {
    total: number;
    written: number;
    reused: number;
    fromCache: number;
  };
  entries: SnapshotEntry[];
};

const ROOT = path.resolve(__dirname, "..");
const DOCS_ROOT = path.join(ROOT, "docs");
const GUIDES_ROOT = path.join(ROOT, "apps/docs/content/guides");
const OUTPUT_ROOT = path.join(ROOT, "apps/docs/.generated/snapshots");
const CACHE_ROOT = path.join(ROOT, ".cache/docs-snapshots");

const DEFAULT_INIT = {
  docPlugins: { tables: true, html: true, mdx: true, math: true, footnotes: true, callouts: true },
  mdx: { compileMode: "server" as const },
  prewarmLangs: ["typescript", "tsx", "javascript", "json", "bash", "diff"],
};

type BuildTarget = {
  kind: SnapshotKind;
  slug: string;
  sourcePath: string;
};

function parseArgs(argv: string[]) {
  const args = new Set(argv.slice(2));
  return {
    clean: args.has("--clean"),
  };
}

async function safeReadJson<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function outputPathFor(kind: SnapshotKind, slug: string): string {
  return path.join(OUTPUT_ROOT, kind, `${slug}.json`);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const primitive = JSON.stringify(value);
    return primitive === undefined ? "null" : primitive;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  const body = entries.map(([key, val]) => `${JSON.stringify(key)}:${stableStringify(val)}`).join(",");
  return `{${body}}`;
}

async function computeSnapshotHashSalt(): Promise<string> {
  // We want cache invalidation when the worker bundle changes. Hashing the built
  // bundle is deterministic and does not rely on git metadata.
  const candidates = [
    // Node snapshot compiler changes should also invalidate snapshot artifacts.
    path.join(ROOT, "packages/markdown-v2-worker/dist/node/index.mjs"),
    path.join(ROOT, "packages/markdown-v2-worker/dist/hosted/markdown-worker.js"),
    path.join(ROOT, "apps/docs/public/workers/markdown-worker.js"),
  ];

  for (const filePath of candidates) {
    try {
      const raw = await fs.readFile(filePath);
      const digest = createHash("sha256").update(raw).digest("hex");
      return `docs-snapshots-v2:${digest}`;
    } catch {
      // try next candidate
    }
  }

  return "docs-snapshots-v2:unknown-worker";
}

function stableHashForText(text: string, salt: string): string {
  // Mirror the worker's stable hashing logic so we can cheaply detect when an
  // on-disk artifact matches the current inputs (including our salt).
  const payload = stableStringify({ text, init: DEFAULT_INIT, salt });
  return createHash("sha256").update(payload).digest("hex");
}

function buildTargets(): BuildTarget[] {
  const docsTargets: BuildTarget[] = DOC_SECTIONS.flatMap((section) =>
    section.items
      .filter((item) => item.slug.length > 0)
      .map((item) => ({
        kind: "docs" as const,
        slug: item.slug,
        sourcePath: path.join(DOCS_ROOT, item.file),
      })),
  );

  const guideTargets: BuildTarget[] = GUIDE_ITEMS.map((item) => ({
    kind: "guides" as const,
    slug: item.slug,
    sourcePath: path.join(GUIDES_ROOT, item.file),
  }));

  return [...docsTargets, ...guideTargets];
}

async function ensureDirs(): Promise<void> {
  await fs.mkdir(path.join(OUTPUT_ROOT, "docs"), { recursive: true });
  await fs.mkdir(path.join(OUTPUT_ROOT, "guides"), { recursive: true });
  await fs.mkdir(CACHE_ROOT, { recursive: true });
}

async function removeOutputRoot(): Promise<void> {
  await fs.rm(OUTPUT_ROOT, { recursive: true, force: true });
}

async function compileTarget(target: BuildTarget, hashSalt: string): Promise<SnapshotEntry> {
  const markdown = await fs.readFile(target.sourcePath, "utf8");
  const predictedHash = stableHashForText(markdown, hashSalt);
  const outputPath = outputPathFor(target.kind, target.slug);
  const existing = await safeReadJson<SnapshotArtifactV1>(outputPath);

  if (existing?.version === 1 && existing.hash === predictedHash && Array.isArray(existing.blocks)) {
    return {
      kind: target.kind,
      slug: target.slug,
      sourcePath: target.sourcePath,
      outputPath,
      hash: existing.hash,
      blockCount: existing.blocks.length,
      fromCache: false,
      reusedArtifact: true,
    };
  }

  const result = await compileMarkdownSnapshot({
    text: markdown,
    init: DEFAULT_INIT,
    hashSalt,
    cache: {
      dir: CACHE_ROOT,
      key: `${hashSalt}:${target.kind}:${target.slug}`,
    },
  });

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, JSON.stringify(result.artifact, null, 2), "utf8");

  return {
    kind: target.kind,
    slug: target.slug,
    sourcePath: target.sourcePath,
    outputPath,
    hash: result.artifact.hash,
    blockCount: result.artifact.blocks.length,
    fromCache: result.fromCache,
    reusedArtifact: false,
  };
}

async function main(): Promise<void> {
  const { clean } = parseArgs(process.argv);
  if (clean) {
    await removeOutputRoot();
  }
  await ensureDirs();

  const hashSalt = await computeSnapshotHashSalt();

  const targets = buildTargets();
  const entries: SnapshotEntry[] = [];

  for (const target of targets) {
    const entry = await compileTarget(target, hashSalt);
    entries.push(entry);
    process.stdout.write(
      `[docs:snapshots] ${entry.kind}/${entry.slug} blocks=${entry.blockCount} cache=${entry.fromCache ? "hit" : "miss"} reused=${entry.reusedArtifact ? "yes" : "no"}\n`,
    );
  }

  const manifest: SnapshotManifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    counts: {
      total: entries.length,
      written: entries.filter((entry) => !entry.reusedArtifact).length,
      reused: entries.filter((entry) => entry.reusedArtifact).length,
      fromCache: entries.filter((entry) => entry.fromCache).length,
    },
    entries,
  };

  const manifestPath = path.join(OUTPUT_ROOT, "manifest.json");
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  process.stdout.write(`[docs:snapshots] manifest=${manifestPath}\n`);
}

main().catch((error) => {
  console.error("[docs:snapshots] failed:", error);
  process.exitCode = 1;
});
