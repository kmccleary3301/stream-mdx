import * as esbuild from "esbuild-wasm";
import type { Plugin } from "esbuild-wasm";
import { compile as compileTailwind } from "tailwindcss";
import type { PreviewCompiler, PreviewInput, TailwindStylesheetLoader, TailwindStylesheetName } from "./types";

export type EsbuildCompilerOptions = Readonly<{
  wasmURL: string | URL;
  loadTailwindStylesheet?: TailwindStylesheetLoader;
}>;

const REACT_RUNTIME_IMPORTS = new Set([
  "react",
  "react-dom",
  "react-dom/client",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
]);
const TAILWIND_STYLESHEETS = new Map<string, TailwindStylesheetName>([
  ["tailwindcss", "index.css"],
  ["tailwindcss/index.css", "index.css"],
  ["tailwindcss/theme.css", "theme.css"],
  ["tailwindcss/preflight.css", "preflight.css"],
  ["tailwindcss/utilities.css", "utilities.css"],
]);
const SOURCE_EXTENSIONS = [".tsx", ".ts", ".jsx", ".js", ".json", ".css"] as const;
const CLASS_STRING = /["'`]([^"'`\r\n]*?)["'`]/g;
let initializationURL: string | null = null;
let initialization: Promise<void> | null = null;

function resolveProjectPath(path: string, importer: string): string | null {
  const segments = importer.length > 0 ? importer.split("/").slice(0, -1) : [];
  for (const segment of path.split("/")) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

function findProjectFile(path: string, files: ReadonlyMap<string, string>): string | null {
  if (files.has(path)) return path;
  if (SOURCE_EXTENSIONS.some((extension) => path.endsWith(extension))) return null;
  for (const extension of SOURCE_EXTENSIONS) {
    const candidate = `${path}${extension}`;
    if (files.has(candidate)) return candidate;
  }
  for (const extension of SOURCE_EXTENSIONS) {
    const candidate = `${path}/index${extension}`;
    if (files.has(candidate)) return candidate;
  }
  return null;
}

function sourceLoader(path: string): "tsx" | "ts" | "jsx" | "js" | "json" | "css" | "dataurl" {
  if (path.endsWith(".tsx")) return "tsx";
  if (path.endsWith(".ts")) return "ts";
  if (path.endsWith(".jsx")) return "jsx";
  if (path.endsWith(".js")) return "js";
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".css")) return "css";
  return "dataurl";
}

function tailwindCandidates(files: ReadonlyMap<string, string>): string[] {
  const candidates = new Set<string>();
  for (const source of files.values()) {
    for (const match of source.matchAll(CLASS_STRING)) {
      for (const candidate of match[1].split(/\s+/)) {
        if (candidate.length > 0) candidates.add(candidate);
      }
    }
  }
  return [...candidates].sort();
}

async function compileProjectStyles(
  path: string,
  source: string,
  input: PreviewInput,
  loadTailwindStylesheet: TailwindStylesheetLoader | undefined,
  isCurrent: () => boolean,
): Promise<string> {
  if (loadTailwindStylesheet === undefined) {
    throw new Error("Tailwind CSS imports require a local stylesheet loader");
  }
  const compiler = await compileTailwind(source, {
    base: path,
    loadStylesheet: async (id, base) => {
      const normalizedId = base === "tailwindcss" && id.startsWith("./") ? `tailwindcss/${id.slice(2)}` : id;
      const tailwindStylesheet = TAILWIND_STYLESHEETS.get(normalizedId);
      if (tailwindStylesheet !== undefined) {
        const content = await loadTailwindStylesheet(tailwindStylesheet, { isCurrent });
        if (!isCurrent()) throw new Error("Preview compilation was superseded");
        return { path: `tailwindcss/${tailwindStylesheet}`, base: "tailwindcss", content };
      }
      const projectPath = resolveProjectPath(id, base);
      const resolved = projectPath === null ? null : findProjectFile(projectPath, input.files);
      if (resolved !== null) {
        return { path: resolved, base: resolved, content: input.files.get(resolved)! };
      }
      throw new Error(`Tailwind stylesheet import "${id}" from "${base}" is not in the local project or runtime`);
    },
  });
  if (!isCurrent()) throw new Error("Preview compilation was superseded");
  return compiler.build(tailwindCandidates(input.files));
}

function virtualProjectPlugin(
  input: PreviewInput,
  options: EsbuildCompilerOptions,
  isCurrent: () => boolean,
): Plugin {
  return {
    name: "stream-mdx-preview-project",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === "entry-point") return { path: input.entry, namespace: "preview-project" };
        if (REACT_RUNTIME_IMPORTS.has(args.path)) return { path: args.path, external: true };
        if (!args.path.startsWith(".") || args.path.includes("\\")) {
          return {
            errors: [
              {
                text: `Preview dependency "${args.path}" imported by "${args.importer}" is not in the local runtime map`,
              },
            ],
          };
        }
        const path = resolveProjectPath(args.path, args.importer);
        const resolved = path === null ? null : findProjectFile(path, input.files);
        if (resolved === null) {
          return {
            errors: [
              {
                text: `Preview project import "${args.path}" from "${args.importer}" was not found`,
              },
            ],
          };
        }
        return { path: resolved, namespace: "preview-project" };
      });
      build.onLoad({ filter: /.*/, namespace: "preview-project" }, async (args) => {
        const source = input.files.get(args.path);
        if (source === undefined) return { errors: [{ text: `Preview project file was not found: ${args.path}` }] };
        const contents =
          args.path.endsWith(".css") && source.includes("@import")
            ? await compileProjectStyles(args.path, source, input, options.loadTailwindStylesheet, isCurrent)
            : source;
        if (!isCurrent()) return { errors: [{ text: "Preview compilation was superseded" }] };
        return { contents, loader: sourceLoader(args.path), resolveDir: "/" };
      });
    },
  };
}

async function initializeEsbuild(wasmURL: string | URL): Promise<void> {
  const url = wasmURL.toString();
  if (initialization !== null) {
    if (initializationURL !== url) {
      throw new Error("esbuild-wasm was already initialized with a different local Wasm URL");
    }
    return initialization;
  }

  initializationURL = url;
  const pending =
    typeof window === "undefined"
      ? esbuild.initialize({})
      : esbuild.initialize({ wasmURL, worker: false });
  initialization = pending;
  try {
    await pending;
  } catch (error) {
    if (initialization === pending) {
      initialization = null;
      initializationURL = null;
    }
    throw error;
  }
}

export function createEsbuildCompiler(options: EsbuildCompilerOptions): PreviewCompiler {
  return async (input, context) => {
    await initializeEsbuild(options.wasmURL);
    if (!context.isCurrent()) throw new Error("Preview compilation was superseded");
    const result = await esbuild.build({
      absWorkingDir: "/",
      entryPoints: [input.entry],
      bundle: true,
      write: false,
      outdir: "/stream-mdx-preview",
      entryNames: "preview",
      assetNames: "assets/[name]-[hash]",
      format: "esm",
      platform: "browser",
      target: "es2020",
      jsx: "automatic",
      jsxImportSource: "react",
      define: { "process.env.NODE_ENV": '\"production\"' },
      plugins: [virtualProjectPlugin(input, options, context.isCurrent)],
    });
    if (!context.isCurrent()) throw new Error("Preview compilation was superseded");
    const javascript = result.outputFiles.find((file) => file.path.endsWith(".js"))?.text;
    if (javascript === undefined) throw new Error("esbuild-wasm produced no JavaScript preview output");
    const css = result.outputFiles.find((file) => file.path.endsWith(".css"))?.text ?? "";
    return { javascript, css };
  };
}

