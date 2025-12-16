import { join } from "node:path";
import { defineConfig } from "tsup";

const resolve = (p: string) => join(__dirname, p);

export default defineConfig({
  entry: ["src/index.ts", "src/core.ts", "src/react.ts", "src/worker.ts", "src/plugins.ts"].map(resolve),
  dts: true,
  sourcemap: true,
  splitting: false,
  clean: true,
  format: ["esm", "cjs"],
  outDir: join(__dirname, "dist"),
  target: "es2020",
  tsconfig: join(__dirname, "tsconfig.build.json"),
  external: [
    "react",
    "react-dom",
    "@stream-mdx/core",
    "@stream-mdx/react",
    "@stream-mdx/worker",
    "@stream-mdx/plugins",
  ],
  outExtension({ format }) {
    return {
      js: format === "cjs" ? ".cjs" : ".mjs",
    };
  },
});

