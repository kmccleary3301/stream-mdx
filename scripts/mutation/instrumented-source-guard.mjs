// Loaded with --import in every mutation child. It proves the tests exercise Stryker's instrumented
// sandbox copy of each mutated file, never the live source, and redirects package specifiers
// (e.g. "@stream-mdx/core") to sandbox source so cross-package consumers run the mutated code.
import { readFileSync, realpathSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const sandboxRoot = realpathSync(process.cwd());
const liveRoot = realpathSync(process.env.STREAM_MDX_MUTATION_LIVE_PACKAGE ?? "");
const mutated = JSON.parse(process.env.STREAM_MDX_MUTATION_FILES ?? "[]");
const redirects = JSON.parse(process.env.STREAM_MDX_MUTATION_REDIRECTS ?? "{}");

if (sandboxRoot === liveRoot) throw new Error("mutation tests must run inside Stryker's sandbox, not the live package");
const sandboxMutated = new Set(mutated.map((file) => path.join(sandboxRoot, file)));
const liveMutated = new Set(mutated.map((file) => path.join(liveRoot, file)));

// Keys are exact specifiers or "prefix/*" patterns whose "*" is substituted into the file pattern,
// so every subpath of a redirected package resolves into the same sandbox module graph.
const exactRedirects = new Map();
const prefixRedirects = [];
for (const [specifier, file] of Object.entries(redirects)) {
  if (specifier.endsWith("/*")) prefixRedirects.push([specifier.slice(0, -1), file]);
  else exactRedirects.set(specifier, pathToFileURL(path.join(sandboxRoot, file)).href);
}

function redirect(specifier) {
  const exact = exactRedirects.get(specifier);
  if (exact) return exact;
  for (const [prefix, file] of prefixRedirects) {
    if (specifier.startsWith(prefix)) {
      return pathToFileURL(path.join(sandboxRoot, file.replace("*", specifier.slice(prefix.length)))).href;
    }
  }
  return undefined;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const url = redirect(specifier);
    return url ? { url, shortCircuit: true } : nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("file:")) {
      const file = fileURLToPath(url);
      if (liveMutated.has(file)) throw new Error(`mutation test loaded live source instead of the sandbox copy: ${file}`);
      if (sandboxMutated.has(file) && !readFileSync(file, "utf8").includes("__STRYKER_ACTIVE_MUTANT__")) {
        throw new Error(`sandbox source is not instrumented: ${file}`);
      }
    }
    return nextLoad(url, context);
  },
});
