import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getHostedWorkerBundleUrl, type CompileMarkdownSnapshotOptions } from "../packages/markdown-v2-worker/src/node/index.ts";

export const DOCS_SNAPSHOT_INIT = {
  docPlugins: { tables: true, html: true, mdx: true, math: true, footnotes: true, callouts: true },
  prewarmLangs: ["typescript", "tsx", "javascript", "json", "bash", "diff"],
} satisfies NonNullable<CompileMarkdownSnapshotOptions["init"]>;

type ProducerArtifact = {
  role: string;
  label: string;
  filePath: string;
};

function relativeArtifactLabel(prefix: string, basePath: string, filePath: string): string | null {
  const relativePath = path.relative(basePath, filePath);
  if (!relativePath || path.isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith(`..${path.sep}`)) {
    return null;
  }
  return `${prefix}/${relativePath.split(path.sep).join("/")}`;
}

function packageArtifactLabel(packageName: string, packageRoot: string, filePath: string): string {
  const label = relativeArtifactLabel(packageName, packageRoot, filePath);
  if (!label) throw new Error(`Snapshot producer path is outside ${packageName}: ${filePath}`);
  return label;
}

function workspaceOrPackageArtifactLabel(root: string, packageName: string, packageRoot: string, filePath: string): string {
  const label = relativeArtifactLabel(packageName, packageRoot, filePath) ?? relativeArtifactLabel("repository", root, filePath);
  if (!label) throw new Error(`Snapshot hosted worker is outside the workspace and worker package: ${filePath}`);
  return label;
}

function resolveWorkerThreadEntry(packageRoot: string): string {
  const candidates = [
    path.join(packageRoot, "dist/node/worker-thread-entry.mjs"),
    path.join(packageRoot, "dist/node/worker-thread-entry.cjs"),
    path.join(packageRoot, "src/node/worker-thread-entry.ts"),
  ];
  const resolved = candidates.find((candidate) => existsSync(candidate));
  if (!resolved) {
    throw new Error("Unable to resolve the Node worker-thread bootstrap from the worker package.");
  }
  return resolved;
}

export async function computeDocsSnapshotHashSalt(root: string): Promise<string> {
  const requireFromRoot = createRequire(path.join(root, "package.json"));
  // Match the source compiler's package-root lookup; this compiled entry is only an anchor, not a hash input.
  const workerPackageAnchorPath = requireFromRoot.resolve("@stream-mdx/worker/node");
  const workerPackageRoot = path.resolve(path.dirname(workerPackageAnchorPath), "..", "..");
  const coreEntryPath = requireFromRoot.resolve("@stream-mdx/core");
  const corePackageRoot = path.resolve(path.dirname(coreEntryPath), "..");
  const threadBootstrapPath = resolveWorkerThreadEntry(workerPackageRoot);
  const hostedWorkerPath = fileURLToPath(getHostedWorkerBundleUrl());

  const producerArtifacts: ProducerArtifact[] = [
    {
      role: "snapshot-runtime-config",
      label: "package.json",
      filePath: path.join(root, "package.json"),
    },
    {
      role: "snapshot-dependency-lock",
      label: "package-lock.json",
      filePath: path.join(root, "package-lock.json"),
    },
    {
      role: "docs-target-catalog",
      label: "apps/docs/lib/docs.ts",
      filePath: path.join(root, "apps/docs/lib/docs.ts"),
    },
    {
      role: "docs-target-catalog",
      label: "apps/docs/content/guides/index.ts",
      filePath: path.join(root, "apps/docs/content/guides/index.ts"),
    },
    {
      role: "docs-target-catalog",
      label: "apps/docs/content/showcase/index.ts",
      filePath: path.join(root, "apps/docs/content/showcase/index.ts"),
    },
    {
      role: "docs-snapshot-generator",
      label: "scripts/compile-docs-snapshots.ts",
      filePath: path.join(root, "scripts/compile-docs-snapshots.ts"),
    },
    {
      role: "docs-snapshot-identity",
      label: "scripts/docs-snapshot-provenance.ts",
      filePath: path.join(root, "scripts/docs-snapshot-provenance.ts"),
    },
    {
      role: "node-compiler-source",
      label: "packages/markdown-v2-worker/src/node/index.ts",
      filePath: path.join(root, "packages/markdown-v2-worker/src/node/index.ts"),
    },
    {
      role: "worker-package-metadata",
      label: packageArtifactLabel("@stream-mdx/worker", workerPackageRoot, path.join(workerPackageRoot, "package.json")),
      filePath: path.join(workerPackageRoot, "package.json"),
    },
    {
      role: "core-package-metadata",
      label: packageArtifactLabel("@stream-mdx/core", corePackageRoot, path.join(corePackageRoot, "package.json")),
      filePath: path.join(corePackageRoot, "package.json"),
    },
    {
      role: "node-core-runtime",
      label: packageArtifactLabel("@stream-mdx/core", corePackageRoot, coreEntryPath),
      filePath: coreEntryPath,
    },
    {
      role: "worker-thread-bootstrap",
      label: packageArtifactLabel("@stream-mdx/worker", workerPackageRoot, threadBootstrapPath),
      filePath: threadBootstrapPath,
    },
    {
      role: "hosted-parser-worker",
      label: workspaceOrPackageArtifactLabel(root, "@stream-mdx/worker", workerPackageRoot, hostedWorkerPath),
      filePath: hostedWorkerPath,
    },
  ];

  const hash = createHash("sha256").update("docs-snapshots-v3\0");
  for (const artifact of producerArtifacts) {
    const bytes = await fs.readFile(artifact.filePath);
    hash.update(artifact.role).update("\0").update(artifact.label).update("\0");
    hash.update(String(bytes.byteLength)).update("\0").update(bytes).update("\0");
  }
  return `docs-snapshots-v3:${hash.digest("hex")}`;
}
