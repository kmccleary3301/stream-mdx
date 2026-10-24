import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, rm, writeFile } from "node:fs/promises";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generatedEntry = join(packageRoot, "src/react-vendor.js");
const vendorOutput = join(packageRoot, "dist/vendor");
const require = createRequire(import.meta.url);
const modules = [
  { specifier: "react", filename: "react.mjs" },
  { specifier: "react-dom", filename: "react-dom.mjs" },
  { specifier: "react-dom/client", filename: "react-dom-client.mjs" },
  { specifier: "react/jsx-runtime", filename: "react-jsx-runtime.mjs" },
  { specifier: "react/jsx-dev-runtime", filename: "react-jsx-dev-runtime.mjs" },
];
const previousNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = "production";

try {
  for (const module of modules) {
    const moduleExports = require(module.specifier);
    if (
      (typeof moduleExports !== "object" && typeof moduleExports !== "function") ||
      moduleExports === null
    ) {
      throw new Error(`Expected ${module.specifier} to resolve to a CommonJS export object`);
    }
    module.exports = moduleExports;
    module.names = Object.keys(moduleExports).filter(
      (name) => name !== "default" && name !== "__esModule" && /^[$A-Z_a-z][$\w]*$/.test(name),
    );
    if (module.names.length === 0) throw new Error(`No named CommonJS exports found for ${module.specifier}`);
  }
} finally {
  if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = previousNodeEnv;
}

const coreLines = modules.map((module, index) => `import __runtime${index} from ${JSON.stringify(module.specifier)};`);
for (const [moduleIndex, module] of modules.entries()) {
  const defaultBinding = `__streamMdxModule${moduleIndex}Default`;
  coreLines.push(`const ${defaultBinding} = __runtime${moduleIndex};`, `export { ${defaultBinding} };`);
  for (const [nameIndex, name] of module.names.entries()) {
    const binding = `__streamMdxModule${moduleIndex}Export${nameIndex}`;
    coreLines.push(
      `const ${binding} = __runtime${moduleIndex}[${JSON.stringify(name)}];`,
      `export { ${binding} };`,
    );
  }
}
coreLines.push("export default __streamMdxModule0Default;", "");

await writeFile(generatedEntry, coreLines.join("\n"), "utf8");
try {
  const tsup = resolve(packageRoot, "../../node_modules/.bin/tsup");
  const result = spawnSync(tsup, ["--config", "tsup.vendor.config.ts"], {
    cwd: packageRoot,
    stdio: "inherit",
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error(`React core build failed with status ${result.status}`);
} finally {
  await rm(generatedEntry, { force: true });
}

await mkdir(vendorOutput, { recursive: true });
for (const [moduleIndex, module] of modules.entries()) {
  const reexportLines = [
    `  __streamMdxModule${moduleIndex}Default as default,`,
    ...module.names.map(
      (name, nameIndex) => `  __streamMdxModule${moduleIndex}Export${nameIndex} as ${name},`,
    ),
  ];
  const wrapper = `export {\n${reexportLines.join("\n")}\n} from "./react-core.mjs";\n`;
  await writeFile(join(vendorOutput, module.filename), wrapper, "utf8");
}

const namedExportCount = modules.reduce((count, module) => count + module.names.length, 0);
console.log(`Built shared React core from ${modules.length} CommonJS modules with ${namedExportCount} named exports.`);
