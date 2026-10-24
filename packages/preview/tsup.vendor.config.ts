import { join } from "node:path";
import { defineConfig } from "tsup";

const resolve = (path: string) => join(__dirname, path);
const sourcemap = process.env.SOURCEMAP === "1" || process.env.SOURCEMAP === "true";

export default defineConfig({
  entry: { "react-core": resolve("src/react-vendor.js") },
  dts: false,
  sourcemap,
  splitting: false,
  clean: false,
  minifySyntax: true,
  format: ["esm"],
  outDir: join(__dirname, "dist/vendor"),
  target: "es2020",
  platform: "browser",
  noExternal: ["js-tokens", "loose-envify", "react", "react-dom", "scheduler"],
  define: {
    "process.env.NODE_ENV": '"production"',
  },
  outExtension() {
    return { js: ".mjs" };
  },
});
