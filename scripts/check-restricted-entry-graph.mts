import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { build, type Metafile, type Plugin } from "esbuild";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoots: Readonly<Record<string, string>> = {
  core: path.join(repositoryRoot, "packages/markdown-v2-core/src"),
  plugins: path.join(repositoryRoot, "packages/markdown-v2-plugins/src"),
  react: path.join(repositoryRoot, "packages/markdown-v2-react/src"),
  worker: path.join(repositoryRoot, "packages/markdown-v2-worker/src"),
};

const workerPackageRoot = path.join(repositoryRoot, "packages/markdown-v2-worker");
const workerRequire = createRequire(path.join(workerPackageRoot, "package.json"));
const workerRealmAliases = {
  "decode-named-character-reference": path.join(workerPackageRoot, "src/entities/named-character-reference.ts"),
  "hast-util-from-html-isomorphic": workerRequire.resolve("hast-util-from-html-isomorphic"),
};

interface EntryRoot {
  readonly label: string;
  readonly entry: string;
  readonly platform: "browser" | "node";
}

interface GraphResult {
  readonly root: EntryRoot;
  readonly inputs: Readonly<Record<string, Metafile["inputs"][string]>>;
  readonly entryInput: string;
}

const restrictedRoots: readonly EntryRoot[] = [
  { label: "default React", entry: "packages/markdown-v2-react/src/index.ts", platform: "browser" },
  { label: "default worker", entry: "packages/markdown-v2-worker/src/index.ts", platform: "browser" },
  { label: "worker direct", entry: "packages/markdown-v2-worker/src/direct.ts", platform: "browser" },
  { label: "worker engine", entry: "packages/markdown-v2-worker/src/engine/index.ts", platform: "browser" },
  { label: "default React server", entry: "packages/markdown-v2-react/src/server.tsx", platform: "node" },
];

const privilegedControls: readonly { root: EntryRoot; expected: readonly ForbiddenKind[] }[] = [
  {
    root: { label: "trusted React entry (positive control)", entry: "packages/markdown-v2-react/src/trusted-mdx/index.ts", platform: "browser" },
    expected: ["evaluator", "compiler", "@mdx-js/mdx"],
  },
  {
    root: { label: "trusted React server entry (positive control)", entry: "packages/markdown-v2-react/src/trusted-mdx/server.tsx", platform: "node" },
    expected: ["evaluator"],
  },
  {
    root: { label: "trusted worker compiler entry (positive control)", entry: "packages/markdown-v2-worker/src/mdx-compile.ts", platform: "browser" },
    expected: ["compiler", "@mdx-js/mdx"],
  },
];

type ForbiddenKind = "compiler" | "evaluator" | "@mdx-js/mdx" | "artifact-frame";
const forbiddenPatterns: Readonly<Record<ForbiddenKind, RegExp>> = {
  compiler: /\/packages\/markdown-v2-worker\/src\/mdx-compile\.(?:ts|tsx|js|mjs)$/,
  evaluator: /\/packages\/markdown-v2-react\/src\/trusted-mdx\/evaluate\.(?:ts|tsx|js|mjs)$/,
  "@mdx-js/mdx": /(?:^|\/)node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?@mdx-js\/mdx\//,
  "artifact-frame": /\/packages\/markdown-v2-react\/src\/components\/artifact-frame\.(?:ts|tsx|js|mjs)$/,
};

function isForbiddenInput(inputPath: string): ForbiddenKind | undefined {
  return (Object.keys(forbiddenPatterns) as ForbiddenKind[]).find((kind) => forbiddenPatterns[kind].test(inputPath));
}

function resolveWorkspaceSource(specifier: string): string | undefined {
  const match = /^@stream-mdx\/([^/]+)(?:\/(.*))?$/.exec(specifier);
  if (!match) return undefined;
  const [, packageName, subpath = ""] = match;
  const sourceRoot = sourceRoots[packageName];
  if (!sourceRoot) {
    throw new Error(`No source mapping is defined for workspace import ${specifier}; refusing to leave it external.`);
  }

  const sourceSubpath = packageName === "react" && subpath === "_internal/trusted-mdx-native-children"
    ? "trusted-mdx/native-children-slot"
    : subpath || "index";
  const base = path.resolve(sourceRoot, sourceSubpath);
  const candidates = [
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mts`,
    `${base}.js`,
    path.join(base, "index.ts"),
    path.join(base, "index.tsx"),
    path.join(base, "index.mts"),
    path.join(base, "index.js"),
  ];
  const result = candidates.find((candidate) => existsSync(candidate));
  if (!result) {
    throw new Error(`Workspace import ${specifier} has no source file under ${sourceRoot}; refusing to resolve it through a possibly stale dist entry.`);
  }
  return result;
}

const workspaceSourceResolver: Plugin = {
  name: "stream-mdx-workspace-source-graph",
  setup(buildContext) {
    buildContext.onResolve({ filter: /^@stream-mdx\// }, (args) => {
      try {
        const resolved = resolveWorkspaceSource(args.path);
        assert.ok(resolved, `Expected a workspace source resolution for ${args.path}`);
        return { path: resolved };
      } catch (error) {
        return { errors: [{ text: error instanceof Error ? error.message : String(error) }] };
      }
    });
  },
};

function absoluteInput(inputPath: string): string {
  return path.isAbsolute(inputPath) ? path.normalize(inputPath) : path.resolve(repositoryRoot, inputPath);
}

async function buildGraph(root: EntryRoot): Promise<GraphResult> {
  const outfile = path.join(repositoryRoot, "tmp/restricted-entry-graph", `${root.label.replaceAll(" ", "-")}.mjs`);
  const result = await build({
    absWorkingDir: repositoryRoot,
    entryPoints: [root.entry],
    outfile,
    bundle: true,
    write: false,
    metafile: true,
    format: "esm",
    platform: root.platform,
    target: "es2022",
    alias: workerRealmAliases,
    treeShaking: true,
    logLevel: "silent",
    plugins: [workspaceSourceResolver],
  });
  if (!result.metafile) throw new Error(`${root.label}: esbuild did not return the requested metafile.`);

  const inputs: Record<string, Metafile["inputs"][string]> = {};
  for (const [inputPath, metadata] of Object.entries(result.metafile.inputs)) {
    inputs[absoluteInput(inputPath)] = metadata;
    for (const edge of metadata.imports) {
      if (edge.external && (/^@stream-mdx\//.test(edge.path) || edge.path === "@mdx-js/mdx")) {
        throw new Error(`${root.label}: unchecked external import ${edge.path} from ${path.relative(repositoryRoot, absoluteInput(inputPath))}.`);
      }
    }
  }

  const entryInput = absoluteInput(root.entry);
  if (!inputs[entryInput]) {
    throw new Error(`${root.label}: entry ${root.entry} is absent from its source module graph.`);
  }
  return { root, inputs, entryInput };
}

function shortestForbiddenChain(graph: GraphResult): { kind: ForbiddenKind; chain: string[] } | undefined {
  const pending: string[] = [graph.entryInput];
  const parent = new Map<string, string | null>([[graph.entryInput, null]]);

  for (let cursor = 0; cursor < pending.length; cursor += 1) {
    const current = pending[cursor];
    const forbiddenKind = isForbiddenInput(current);
    if (forbiddenKind) {
      const chain = [current];
      let previous = parent.get(current);
      while (previous) {
        chain.push(previous);
        previous = parent.get(previous);
      }
      return { kind: forbiddenKind, chain: chain.reverse() };
    }

    const metadata = graph.inputs[current];
    if (!metadata) continue;
    for (const edge of metadata.imports) {
      if (edge.external) continue;
      const destination = absoluteInput(edge.path);
      if (!graph.inputs[destination] || parent.has(destination)) continue;
      parent.set(destination, current);
      pending.push(destination);
    }
  }
  return undefined;
}

function inputKinds(graph: GraphResult): Set<ForbiddenKind> {
  const kinds = new Set<ForbiddenKind>();
  for (const inputPath of Object.keys(graph.inputs)) {
    const kind = isForbiddenInput(inputPath);
    if (kind) kinds.add(kind);
  }
  return kinds;
}

function displayChain(chain: readonly string[]): string {
  return chain.map((inputPath) => path.relative(repositoryRoot, inputPath) || inputPath).join(" -> ");
}

async function main(): Promise<void> {
  const restrictedGraphs: GraphResult[] = [];
  for (const root of restrictedRoots) restrictedGraphs.push(await buildGraph(root));
  for (const graph of restrictedGraphs) {
    const chain = shortestForbiddenChain(graph);
    if (chain) {
      throw new Error(`${graph.root.label}: forbidden ${chain.kind} is reachable through the shortest import chain:\n  ${displayChain(chain.chain)}`);
    }
  }

  const controlGraphs: GraphResult[] = [];
  for (const { root } of privilegedControls) controlGraphs.push(await buildGraph(root));
  for (let index = 0; index < controlGraphs.length; index += 1) {
    const graph = controlGraphs[index];
    const control = privilegedControls[index];
    const found = inputKinds(graph);
    const missing = control.expected.filter((kind) => !found.has(kind));
    if (missing.length > 0) {
      throw new Error(`${graph.root.label}: positive control did not reach the expected privileged modules: ${missing.join(", ")}.`);
    }
  }

  console.log(`[stream-mdx] Restricted source graph passed for ${restrictedGraphs.length} public roots; privileged positive controls remained separate.`);
}

await main();
