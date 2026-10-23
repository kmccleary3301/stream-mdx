import * as esbuild from "esbuild-wasm";
import type { Plugin } from "esbuild-wasm";
import type { PreviewCompiler, PreviewInput } from "./types";

export type EsbuildCompilerOptions = Readonly<{ wasmURL: string | URL }>;

const REACT_RUNTIME_IMPORTS = new Set([
  "react",
  "react-dom",
  "react-dom/client",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
]);
const SOURCE_EXTENSIONS = [".tsx", ".ts", ".jsx", ".js", ".json", ".css"] as const;
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

function virtualProjectPlugin(input: PreviewInput): Plugin {
  return {
    name: "stream-mdx-preview-project",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === "entry-point") return { path: input.entry, namespace: "preview-project" };
        if (REACT_RUNTIME_IMPORTS.has(args.path)) return { path: args.path, external: true };
        if (!args.path.startsWith(".") || args.path.includes("\\")) {
          return { errors: [{ text: `Preview dependency is not in the local runtime map: ${args.path}` }] };
        }
        const path = resolveProjectPath(args.path, args.importer);
        const resolved = path === null ? null : findProjectFile(path, input.files);
        if (resolved === null) {
          return { errors: [{ text: `Preview project import was not found: ${args.path}` }] };
        }
        return { path: resolved, namespace: "preview-project" };
      });
      build.onLoad({ filter: /.*/, namespace: "preview-project" }, (args) => {
        const source = input.files.get(args.path);
        if (source === undefined) return { errors: [{ text: `Preview project file was not found: ${args.path}` }] };
        return { contents: source, loader: sourceLoader(args.path), resolveDir: "/" };
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
  const pending = esbuild.initialize({ wasmURL, worker: false });
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
      plugins: [virtualProjectPlugin(input)],
    });
    if (!context.isCurrent()) throw new Error("Preview compilation was superseded");
    const javascript = result.outputFiles.find((file) => file.path.endsWith(".js"))?.text;
    if (javascript === undefined) throw new Error("esbuild-wasm produced no JavaScript preview output");
    const css = result.outputFiles.find((file) => file.path.endsWith(".css"))?.text ?? "";
    return { javascript, css };
  };
}
