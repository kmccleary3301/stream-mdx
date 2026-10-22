import fs from "node:fs/promises";
import path from "node:path";
import { createRequire, type NodeRequire } from "node:module";
import { performance } from "node:perf_hooks";
import type { Worker } from "node:worker_threads";
import { fileURLToPath, pathToFileURL } from "node:url";

import { JSDOM } from "jsdom";

import { normalizeHtmlSemantics } from "../../tests/conformance/normalizer.mts";
import type { DenseFixture } from "../perf/replay-fixtures";

const requireFromHere = createRequire(import.meta.url);
const { DENSE_FIXTURES } = requireFromHere("../perf/replay-fixtures.ts") as { DENSE_FIXTURES: DenseFixture[] };

type SpecExample = {
  markdown: string;
  html: string;
  section: string;
  number: number;
};

type ConformanceExample = {
  id: string;
  suite: "commonmark" | "gfm";
  markdown: string;
  expectedHtml: string;
};

type Classification = "candidate-fixes-spec" | "candidate-regresses-spec" | "both-off-spec" | "no-spec";
type Chunking = "static" | "1" | "7" | "64";

type AllowlistEntry = {
  id: string;
  chunking: Chunking | "*";
  classification: Classification;
  reason: string;
};

type RendererStore = {
  reset: (blocks: unknown[]) => void;
  resetSnapshot?: (snapshot: unknown) => void;
  applyPatches: (patches: unknown[]) => void;
};

type ReactModule = {
  createElement: (type: unknown, props: Record<string, unknown>) => unknown;
};

type ReactDomServerModule = {
  renderToStaticMarkup: (element: unknown) => string;
};

type ServerModule = {
  ComponentRegistry: new () => object;
  MarkdownBlocksRenderer: unknown;
  createRendererStore: (blocks?: unknown[]) => RendererStore;
};

type DirectModule = {
  compileMarkdownSnapshotDirect: (input: { text: string; init: Record<string, unknown> }) => Promise<{ blocks: unknown[] }>;
};

type WorkerNodeModule = {
  createWorkerThread: (options?: { workerBundle?: string; stdout?: boolean; stderr?: boolean }) => Worker;
};

type CoreModule = {
  STREAM_MDX_SCHEMA_VERSION?: unknown;
};

type LoadedSide = {
  name: "candidate" | "base";
  root: string;
  modules: Record<string, string>;
  schemaVersion: unknown;
  react: ReactModule;
  reactDomServer: ReactDomServerModule;
  server: ServerModule;
  direct: DirectModule;
  workerNode: WorkerNodeModule;
};

type StreamResult = {
  normalized: string;
  initializationPath: "resetSnapshot" | "reset(blocks)";
  initializedSchemaVersion?: unknown;
};

type Comparison = {
  id: string;
  sourceKind: "spec" | "fixture";
  chunking: Chunking;
  frontier: number;
  classification: Classification | null;
  equal: boolean;
  allowlisted: boolean;
  allowlistReason?: string;
  candidateNormalized: string;
  baseNormalized: string;
  expectedNormalized?: string;
};

type Difference = Comparison & {
  classification: Classification;
};

type RunOptions = {
  jsonPath?: string;
  proposePath?: string;
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ALLOWLIST_PATH = path.join(ROOT, "tests/conformance/base-differential-allowlist.json");
const CHUNKINGS: Chunking[] = ["static", "1", "7", "64"];
const CLASSIFICATIONS: Classification[] = ["candidate-fixes-spec", "candidate-regresses-spec", "both-off-spec", "no-spec"];
const originalWarn = console.warn;
const originalError = console.error;

function silenceConsole(): void {
  console.warn = (...args: unknown[]) => {
    const message = String(args[0] ?? "");
    if (
      message.includes("[Shiki]") ||
      message.includes("Failed to load language") ||
      (message.startsWith("Unsupported language ") && message.endsWith(", falling back to text"))
    ) return;
    originalWarn(...args);
  };
  console.error = (...args: unknown[]) => {
    const message = String(args[0] ?? "");
    if (message.includes("useLayoutEffect does nothing on the server") || message.includes("Language `")) return;
    originalError(...args);
  };
}

function restoreConsole(): void {
  console.warn = originalWarn;
  console.error = originalError;
}

function parseArgs(args: string[]): RunOptions {
  const options: RunOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag !== "--json" && flag !== "--propose") throw new Error(`Unknown argument: ${flag}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a path`);
    const resolved = path.resolve(ROOT, value);
    if (flag === "--json") options.jsonPath = resolved;
    else options.proposePath = resolved;
    index += 1;
  }
  if (options.jsonPath && options.proposePath && options.jsonPath === options.proposePath) {
    throw new Error("--json and --propose must use different paths");
  }
  return options;
}

function createInitConfig(schemaVersion: unknown): Record<string, unknown> {
  return {
    ...(schemaVersion === undefined ? {} : { schemaVersion }),
    docPlugins: { html: true, tables: true, footnotes: true, math: true, callouts: true, mdx: false },
    mdx: { compileMode: "server" },
    prewarmLangs: [],
  };
}

async function loadExamples(): Promise<ConformanceExample[]> {
  const commonmarkPath = path.join(ROOT, "tests/conformance/fixtures/commonmark-spec-0.31.2.json");
  const gfmPath = path.join(ROOT, "tests/conformance/fixtures/gfm-spec-extensions.json");
  const [commonmarkRaw, gfmRaw] = await Promise.all([
    fs.readFile(commonmarkPath, "utf8"),
    fs.readFile(gfmPath, "utf8"),
  ]);
  const untab = (example: SpecExample): SpecExample => ({
    ...example,
    markdown: example.markdown.replace(/→/g, "\t"),
    html: example.html.replace(/→/g, "\t"),
  });
  const commonmarkExamples = (JSON.parse(commonmarkRaw) as SpecExample[]).map(untab);
  const gfmExamples = (JSON.parse(gfmRaw) as SpecExample[]).map(untab);
  const gfmExpectedOverrides: Record<string, string> = {
    "commonmark#602": '<p>&lt;<a href="https://foo.bar/baz">https://foo.bar/baz</a> bim&gt;</p>',
    "commonmark#608": '<p>&lt; <a href="https://foo.bar">https://foo.bar</a> &gt;</p>',
    "commonmark#611": '<p><a href="https://example.com">https://example.com</a></p>',
    "commonmark#612": '<p><a href="mailto:foo@bar.example.com">foo@bar.example.com</a></p>',
  };
  return [
    ...commonmarkExamples.map((example) => {
      const id = `commonmark#${example.number}`;
      return { id, suite: "commonmark" as const, markdown: example.markdown, expectedHtml: gfmExpectedOverrides[id] ?? example.html };
    }),
    ...gfmExamples.map((example) => ({
      id: `gfm#${example.number}`,
      suite: "gfm" as const,
      markdown: example.markdown,
      expectedHtml: example.html,
    })),
  ];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function moduleExports(namespace: Record<string, unknown>): Record<string, unknown> {
  const defaultExport = namespace.default;
  if (defaultExport && typeof defaultExport === "object") {
    return { ...(defaultExport as Record<string, unknown>), ...namespace };
  }
  return namespace;
}

function requiredExport<T>(namespace: Record<string, unknown>, name: string, side: string): T {
  const value = namespace[name];
  if (value === undefined) throw new Error(`${side} module is missing required export ${name}`);
  return value as T;
}

function isWithinRoot(root: string, filePath: string): boolean {
  const relative = path.relative(root, filePath);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function loadResolvedModule(
  side: "candidate" | "base",
  root: string,
  packageRequire: NodeRequire,
  specifier: string,
): Promise<{ filePath: string; exports: Record<string, unknown> }> {
  let filePath: string;
  try {
    filePath = packageRequire.resolve(specifier);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const baseInstructions = `Run npm run -s build:packages and npm run -s worker:build in ${root}.`;
    throw new Error(`Could not resolve ${specifier} from ${side} root ${root}: ${detail}${side === "base" ? ` ${baseInstructions}` : ""}`);
  }
  if (!isWithinRoot(root, filePath)) {
    throw new Error(`${side} package ${specifier} resolved outside its worktree: ${filePath}`);
  }
  const namespace = (await import(pathToFileURL(filePath).href)) as Record<string, unknown>;
  return { filePath, exports: moduleExports(namespace) };
}

async function assertBuilt(root: string, side: "candidate" | "base"): Promise<void> {
  try {
    await fs.access(path.join(root, "package.json"));
  } catch {
    throw new Error(`${side} root does not contain package.json: ${root}`);
  }
  const artifacts = [
    "packages/markdown-v2-core/dist/index.cjs",
    "packages/markdown-v2-worker/dist/direct.cjs",
    "packages/markdown-v2-worker/dist/node/index.cjs",
    "packages/markdown-v2-worker/dist/node/worker-thread-entry.mjs",
    "packages/markdown-v2-worker/dist/hosted/markdown-worker.js",
    "packages/markdown-v2-react/dist/server.cjs",
  ];
  const missing: string[] = [];
  for (const artifact of artifacts) {
    try {
      await fs.access(path.join(root, artifact));
    } catch {
      missing.push(artifact);
    }
  }
  if (missing.length > 0) {
    const instructions = `Run npm run -s build:packages and npm run -s worker:build in ${root}.`;
    throw new Error(`${side} worktree is not built; missing ${missing.join(", ")}. ${instructions}`);
  }
}

async function loadSide(name: "candidate" | "base", root: string): Promise<LoadedSide> {
  const packageRequire = createRequire(path.join(root, "package.json"));
  const entries = await Promise.all([
    loadResolvedModule(name, root, packageRequire, "@stream-mdx/react/server"),
    loadResolvedModule(name, root, packageRequire, "@stream-mdx/worker/direct"),
    loadResolvedModule(name, root, packageRequire, "@stream-mdx/worker/node"),
    loadResolvedModule(name, root, packageRequire, "@stream-mdx/core"),
    loadResolvedModule(name, root, packageRequire, "react"),
    loadResolvedModule(name, root, packageRequire, "react-dom/server"),
  ]);
  const [server, direct, workerNode, core, react, reactDomServer] = entries;
  const schemaVersion = core.exports.STREAM_MDX_SCHEMA_VERSION;
  if (name === "candidate" && schemaVersion === undefined) {
    throw new Error("candidate core module does not export STREAM_MDX_SCHEMA_VERSION");
  }
  const modules = {
    "@stream-mdx/react/server": server.filePath,
    "@stream-mdx/worker/direct": direct.filePath,
    "@stream-mdx/worker/node": workerNode.filePath,
    "@stream-mdx/core": core.filePath,
    react: react.filePath,
    "react-dom/server": reactDomServer.filePath,
    "worker-thread bootstrap": path.join(root, "packages/markdown-v2-worker/dist/node/worker-thread-entry.mjs"),
    "hosted worker bundle": path.join(root, "packages/markdown-v2-worker/dist/hosted/markdown-worker.js"),
  };
  requiredExport(react.exports, "createElement", name);
  requiredExport(reactDomServer.exports, "renderToStaticMarkup", name);
  return {
    name,
    root,
    modules,
    schemaVersion,
    react: react.exports as unknown as ReactModule,
    reactDomServer: reactDomServer.exports as unknown as ReactDomServerModule,
    server: {
      ComponentRegistry: requiredExport(server.exports, "ComponentRegistry", name),
      MarkdownBlocksRenderer: requiredExport(server.exports, "MarkdownBlocksRenderer", name),
      createRendererStore: requiredExport(server.exports, "createRendererStore", name),
    },
    direct: {
      compileMarkdownSnapshotDirect: requiredExport(direct.exports, "compileMarkdownSnapshotDirect", name),
    },
    workerNode: {
      createWorkerThread: requiredExport(workerNode.exports, "createWorkerThread", name),
    },
  };
}

// The worker adapter discovers its bootstrap entry from cwd, so resolve each side in its own root.
function createWorkerForSide(side: LoadedSide): Worker {
  const previousCwd = process.cwd();
  try {
    process.chdir(side.root);
    return side.workerNode.createWorkerThread({
      workerBundle: path.join(side.root, "packages/markdown-v2-worker/dist/hosted/markdown-worker.js"),
      stdout: true,
      stderr: true,
    });
  } finally {
    process.chdir(previousCwd);
  }
}

function renderStore(side: LoadedSide, store: RendererStore): string {
  const element = side.react.createElement(side.server.MarkdownBlocksRenderer, {
    blocks: [],
    store,
    componentRegistry: new side.server.ComponentRegistry(),
  });
  return normalizeHtmlSemantics(side.reactDomServer.renderToStaticMarkup(element));
}

async function renderStatic(side: LoadedSide, markdown: string): Promise<string> {
  const compiled = await side.direct.compileMarkdownSnapshotDirect({
    text: markdown,
    init: createInitConfig(side.schemaVersion),
  });
  const store = side.server.createRendererStore(compiled.blocks);
  return renderStore(side, store);
}

function workerError(message: Record<string, unknown>): Error {
  const payload = isObject(message.error) ? message.error : {};
  const phase = typeof message.phase === "string" ? message.phase : "unknown";
  const text = typeof payload.message === "string" ? payload.message : "unspecified worker error";
  return new Error(`Worker reported ${phase} error: ${text}`);
}

class StreamingRenderer {
  private readonly worker: Worker;
  private readonly side: LoadedSide;
  private current: {
    store: RendererStore | null;
    initializationPath: StreamResult["initializationPath"] | null;
    initializedSchemaVersion?: unknown;
    resolve: (result: StreamResult) => void;
    reject: (error: Error) => void;
  } | null = null;
  private fatalError: Error | null = null;
  private stopped = false;
  readonly initializationPaths = new Set<string>();
  readonly initializedSchemaVersions = new Set<string>();

  constructor(side: LoadedSide) {
    this.side = side;
    this.worker = createWorkerForSide(side);
    this.worker.stdout?.resume();
    this.worker.stderr?.resume();
    this.worker.on("message", (rawMessage: unknown) => this.onMessage(rawMessage));
    this.worker.on("error", (error: Error) => this.fail(error));
    this.worker.on("exit", (code: number) => {
      if (!this.stopped) this.fail(new Error(`${side.name} worker exited unexpectedly with code ${code}`));
    });
  }

  render(markdown: string, chunkSize: number): Promise<StreamResult> {
    if (this.fatalError) return Promise.reject(this.fatalError);
    if (this.current) return Promise.reject(new Error(`${this.side.name} worker already has an active render`));
    return new Promise((resolve, reject) => {
      this.current = { store: null, initializationPath: null, resolve, reject };
      try {
        this.worker.postMessage({ type: "INIT", initialContent: "", ...createInitConfig(this.side.schemaVersion) });
        for (let index = 0; index < markdown.length; index += chunkSize) {
          this.worker.postMessage({ type: "APPEND", text: markdown.slice(index, index + chunkSize) });
        }
        this.worker.postMessage({ type: "FINALIZE" });
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private onMessage(rawMessage: unknown): void {
    const session = this.current;
    if (!session || !isObject(rawMessage) || typeof rawMessage.type !== "string") return;
    try {
      if (rawMessage.type === "ERROR") {
        this.fail(workerError(rawMessage));
        return;
      }
      if (rawMessage.type === "INITIALIZED") {
        if (session.store) throw new Error(`${this.side.name} worker sent multiple INITIALIZED messages`);
        const store = this.side.server.createRendererStore();
        if (typeof store.resetSnapshot === "function" && rawMessage.snapshot !== undefined) {
          store.resetSnapshot(rawMessage.snapshot);
          session.initializationPath = "resetSnapshot";
        } else {
          if (!Array.isArray(rawMessage.blocks)) {
            throw new Error(`${this.side.name} INITIALIZED has no usable snapshot or blocks for store.reset(msg.blocks)`);
          }
          store.reset(rawMessage.blocks);
          session.initializationPath = "reset(blocks)";
        }
        session.store = store;
        this.initializationPaths.add(session.initializationPath);
        if (rawMessage.schemaVersion !== undefined) {
          session.initializedSchemaVersion = rawMessage.schemaVersion;
          this.initializedSchemaVersions.add(JSON.stringify(rawMessage.schemaVersion));
        }
        return;
      }
      if (rawMessage.type === "PATCH") {
        if (!session.store) throw new Error(`${this.side.name} worker sent PATCH before INITIALIZED`);
        if (!Array.isArray(rawMessage.patches)) throw new Error(`${this.side.name} worker PATCH has no patches array`);
        session.store.applyPatches(rawMessage.patches);
        return;
      }
      if (rawMessage.type === "FINALIZED") {
        if (!session.store || !session.initializationPath) {
          throw new Error(`${this.side.name} worker finalized before INITIALIZED`);
        }
        const result: StreamResult = {
          normalized: renderStore(this.side, session.store),
          initializationPath: session.initializationPath,
          ...(session.initializedSchemaVersion === undefined ? {} : { initializedSchemaVersion: session.initializedSchemaVersion }),
        };
        this.current = null;
        session.resolve(result);
      }
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private fail(error: Error): void {
    this.fatalError = error;
    const session = this.current;
    this.current = null;
    session?.reject(error);
  }

  async close(): Promise<void> {
    this.stopped = true;
    if (this.current) {
      const session = this.current;
      this.current = null;
      session.reject(new Error(`${this.side.name} worker closed while rendering`));
    }
    await this.worker.terminate();
  }
}

function parseAllowlistEntry(value: unknown, index: number): AllowlistEntry {
  if (!isObject(value)) throw new Error(`Allowlist entry ${index} is not an object`);
  const { id, chunking, classification, reason } = value;
  if (typeof id !== "string" || id.length === 0) throw new Error(`Allowlist entry ${index} has no id`);
  if (typeof chunking !== "string" || !(CHUNKINGS as string[]).includes(chunking) && chunking !== "*") {
    throw new Error(`Allowlist entry ${index} has invalid chunking`);
  }
  if (typeof classification !== "string" || !(CLASSIFICATIONS as string[]).includes(classification)) {
    throw new Error(`Allowlist entry ${index} has invalid classification`);
  }
  if (typeof reason !== "string" || reason.trim().length === 0) {
    throw new Error(`Allowlist entry ${index} must have a non-empty approved reason`);
  }
  return { id, chunking: chunking as AllowlistEntry["chunking"], classification: classification as Classification, reason };
}

async function loadAllowlist(): Promise<AllowlistEntry[]> {
  const parsed: unknown = JSON.parse(await fs.readFile(ALLOWLIST_PATH, "utf8"));
  if (!Array.isArray(parsed)) throw new Error(`${ALLOWLIST_PATH} must contain a JSON array`);
  return parsed.map(parseAllowlistEntry);
}

function classifyDifference(candidate: string, base: string, expected: string | undefined): Classification | null {
  if (candidate === base) return null;
  if (expected === undefined) return "no-spec";
  const candidateMatches = candidate === expected;
  const baseMatches = base === expected;
  if (candidateMatches && !baseMatches) return "candidate-fixes-spec";
  if (!candidateMatches && baseMatches) return "candidate-regresses-spec";
  return "both-off-spec";
}

function findAllowlistEntry(
  entries: AllowlistEntry[],
  id: string,
  chunking: Chunking,
  classification: Classification,
): AllowlistEntry | undefined {
  return entries.find((entry) =>
    entry.id === id &&
    entry.classification === classification &&
    (entry.chunking === chunking || entry.chunking === "*"),
  );
}

function firstDifferenceSnippet(value: string, other: string): string {
  let index = 0;
  const limit = Math.min(value.length, other.length);
  while (index < limit && value[index] === other[index]) index += 1;
  const start = Math.max(0, index - 40);
  const end = Math.min(value.length, start + 120);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < value.length ? "…" : "";
  return `${prefix}${value.slice(start, end)}${suffix}`;
}

function buildSummary(comparisons: Comparison[]): {
  differences: number;
  allowlisted: number;
  unlisted: number;
  byClassification: Record<Classification, number>;
  byChunking: Record<Chunking, number>;
  byClassificationAndChunking: Record<Classification, Record<Chunking, number>>;
} {
  const differences = comparisons.filter((comparison) => comparison.classification !== null);
  const byClassification = Object.fromEntries(CLASSIFICATIONS.map((classification) => [classification, 0])) as Record<Classification, number>;
  const byChunking = Object.fromEntries(CHUNKINGS.map((chunking) => [chunking, 0])) as Record<Chunking, number>;
  const byClassificationAndChunking = Object.fromEntries(
    CLASSIFICATIONS.map((classification) => [
      classification,
      Object.fromEntries(CHUNKINGS.map((chunking) => [chunking, 0])),
    ]),
  ) as Record<Classification, Record<Chunking, number>>;
  for (const difference of differences) {
    const classification = difference.classification as Classification;
    byClassification[classification] += 1;
    byChunking[difference.chunking] += 1;
    byClassificationAndChunking[classification][difference.chunking] += 1;
  }
  return {
    differences: differences.length,
    allowlisted: differences.filter((difference) => difference.allowlisted).length,
    unlisted: differences.filter((difference) => !difference.allowlisted).length,
    byClassification,
    byChunking,
    byClassificationAndChunking,
  };
}

function formatCounts(values: Record<string, number>): string {
  return Object.entries(values).map(([key, value]) => `${key}:${value}`).join(",");
}

function printLoadedModules(candidate: LoadedSide, base: LoadedSide, jsdomPath: string): void {
  for (const side of [candidate, base]) {
    console.log(`loaded ${side.name} schemaVersion=${JSON.stringify(side.schemaVersion)}`);
    for (const [specifier, filePath] of Object.entries(side.modules)) {
      console.log(`loaded ${side.name} ${specifier}: ${filePath}`);
    }
  }
  console.log(`loaded shared jsdom: ${jsdomPath}`);
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function main(): Promise<number> {
  const startedAt = performance.now();
  silenceConsole();
  const options = parseArgs(process.argv.slice(2));
  const baseRootInput = process.env.STREAM_MDX_BASE_ROOT;
  if (!baseRootInput) throw new Error("STREAM_MDX_BASE_ROOT is required and must point to the built R0 worktree.");
  if (!path.isAbsolute(baseRootInput)) throw new Error(`STREAM_MDX_BASE_ROOT must be absolute: ${baseRootInput}`);
  let baseRoot: string;
  try {
    baseRoot = await fs.realpath(baseRootInput);
  } catch {
    throw new Error(`STREAM_MDX_BASE_ROOT does not exist or is inaccessible: ${baseRootInput}`);
  }
  const candidateRoot = await fs.realpath(ROOT);
  await Promise.all([assertBuilt(candidateRoot, "candidate"), assertBuilt(baseRoot, "base")]);

  const { window: domWindow } = new JSDOM("<!doctype html>");
  Object.assign(globalThis, {
    window: domWindow,
    document: domWindow.document,
    DOMParser: domWindow.DOMParser,
    Node: domWindow.Node,
    Element: domWindow.Element,
    HTMLElement: domWindow.HTMLElement,
  });
  const [candidate, base, allowlist, examples] = await Promise.all([
    loadSide("candidate", candidateRoot),
    loadSide("base", baseRoot),
    loadAllowlist(),
    loadExamples(),
  ]);
  const candidateRequire = createRequire(path.join(candidateRoot, "package.json"));
  const jsdomPath = candidateRequire.resolve("jsdom");
  printLoadedModules(candidate, base, jsdomPath);

  const comparisons: Comparison[] = [];
  const runners: StreamingRenderer[] = [];
  try {
    const candidateRunner = new StreamingRenderer(candidate);
    runners.push(candidateRunner);
    const baseRunner = new StreamingRenderer(base);
    runners.push(baseRunner);

    const addComparison = (
      id: string,
      sourceKind: Comparison["sourceKind"],
      chunking: Chunking,
      frontier: number,
      candidateNormalized: string,
      baseNormalized: string,
      expectedNormalized?: string,
    ): void => {
      const classification = classifyDifference(candidateNormalized, baseNormalized, expectedNormalized);
      const approved = classification === null ? undefined : findAllowlistEntry(allowlist, id, chunking, classification);
      comparisons.push({
        id,
        sourceKind,
        chunking,
        frontier,
        classification,
        equal: classification === null,
        allowlisted: Boolean(approved),
        ...(approved ? { allowlistReason: approved.reason } : {}),
        candidateNormalized,
        baseNormalized,
        ...(expectedNormalized === undefined ? {} : { expectedNormalized }),
      });
    };

    const runCase = async (
      id: string,
      sourceKind: Comparison["sourceKind"],
      markdown: string,
      expectedNormalized: string | undefined,
      chunkings: Chunking[],
    ): Promise<void> => {
      const [candidateStatic, baseStatic] = await Promise.all([
        renderStatic(candidate, markdown),
        renderStatic(base, markdown),
      ]);
      addComparison(id, sourceKind, "static", markdown.length, candidateStatic, baseStatic, expectedNormalized);
      for (const chunking of chunkings) {
        if (chunking === "static") continue;
        const size = Number(chunking);
        const [candidateStream, baseStream] = await Promise.all([
          candidateRunner.render(markdown, size),
          baseRunner.render(markdown, size),
        ]);
        addComparison(id, sourceKind, chunking, markdown.length, candidateStream.normalized, baseStream.normalized, expectedNormalized);
      }
    };

    for (const example of examples) {
      await runCase(
        example.id,
        "spec",
        example.markdown,
        normalizeHtmlSemantics(example.expectedHtml),
        ["static", "1", "7", "64"],
      );
    }
    for (const fixture of DENSE_FIXTURES) {
      await runCase(fixture.id, "fixture", fixture.source, undefined, ["static", "64"]);
    }
  } finally {
    await Promise.all(runners.map((runner) => runner.close()));
  }

  const summary = buildSummary(comparisons);
  const runtimeSeconds = (performance.now() - startedAt) / 1000;
  const proposal = comparisons
    .filter((comparison): comparison is Difference => comparison.classification !== null)
    .map(({ id, chunking, classification }) => ({ id, chunking, classification, reason: "" }));
  const report = {
    generatedAt: new Date().toISOString(),
    runtimeSeconds,
    candidateRoot,
    baseRoot,
    loadedModules: {
      candidate: candidate.modules,
      base: base.modules,
      shared: { jsdom: jsdomPath },
    },
    schemaVersions: { candidate: candidate.schemaVersion, base: base.schemaVersion },
    initializationPaths: {
      candidate: [...new Set(runners[0]?.initializationPaths ?? [])],
      base: [...new Set(runners[1]?.initializationPaths ?? [])],
    },
    initializedSchemaVersions: {
      candidate: [...new Set(runners[0]?.initializedSchemaVersions ?? [])],
      base: [...new Set(runners[1]?.initializedSchemaVersions ?? [])],
    },
    counts: {
      specExamples: examples.length,
      replayFixtures: DENSE_FIXTURES.length,
      comparisons: comparisons.length,
      ...summary,
    },
    comparisons,
    proposedAllowlist: proposal,
  };

  if (options.proposePath) await writeJson(options.proposePath, proposal);
  if (options.jsonPath) await writeJson(options.jsonPath, report);

  const crossCounts = CLASSIFICATIONS.map((classification) =>
    `${classification}[${formatCounts(summary.byClassificationAndChunking[classification])}]`,
  ).join(";");
  console.log(
    `Base differential: spec=${examples.length} fixtures=${DENSE_FIXTURES.length} comparisons=${comparisons.length} differences=${summary.differences} allowlisted=${summary.allowlisted} unlisted=${summary.unlisted}; classification={${formatCounts(summary.byClassification)}} chunking={${formatCounts(summary.byChunking)}} cross={${crossCounts}}; base-init={${[...baseRunnerPaths(report.initializationPaths.base)].join(",") || "none"}} runtime=${runtimeSeconds.toFixed(2)}s proposal=${options.proposePath ?? "not-requested"}`,
  );

  const differences = comparisons.filter((comparison): comparison is Difference => comparison.classification !== null);
  const regressions = differences.filter((difference) => difference.classification === "candidate-regresses-spec");
  const unlistedExamples = differences.filter((difference) => !difference.allowlisted && difference.classification !== "candidate-regresses-spec");
  for (const difference of regressions) printDifference(difference, true);
  let examplesPrinted = 0;
  for (const difference of unlistedExamples) {
    if (examplesPrinted >= 20) break;
    printDifference(difference, false);
    examplesPrinted += 1;
  }
  const suppressed = unlistedExamples.length - examplesPrinted;
  if (suppressed > 0) console.log(`... ${suppressed} additional unlisted non-regression differences are in the JSON report`);

  if (options.jsonPath) console.log(`Wrote full report to ${options.jsonPath}`);
  if (options.proposePath) console.log(`Wrote proposed allowlist to ${options.proposePath}`);
  return summary.unlisted === 0 ? 0 : 1;
}

function baseRunnerPaths(paths: unknown): string[] {
  return Array.isArray(paths) ? paths.filter((entry): entry is string => typeof entry === "string") : [];
}

function printDifference(difference: Difference, regression: boolean): void {
  const status = difference.allowlisted ? "ALLOWLISTED" : "FAIL";
  const candidateSnippet = firstDifferenceSnippet(difference.candidateNormalized, difference.baseNormalized);
  const baseSnippet = firstDifferenceSnippet(difference.baseNormalized, difference.candidateNormalized);
  console.log(
    `${status}${regression ? " candidate-regresses-spec" : ""} id=${difference.id} chunking=${difference.chunking} frontier=${difference.frontier} classification=${difference.classification} candidate=${JSON.stringify(candidateSnippet)} base=${JSON.stringify(baseSnippet)}`,
  );
}

main()
  .then((exitCode) => {
    restoreConsole();
    process.exitCode = exitCode;
  })
  .catch((error: unknown) => {
    restoreConsole();
    if (error instanceof Error && error.stack) process.stderr.write(`${error.stack}\n`);
    else process.stderr.write(`ERR: ${String(error)}\n`);
    process.exitCode = 1;
  });
