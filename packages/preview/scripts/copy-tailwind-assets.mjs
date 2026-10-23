import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const tailwindRoot = dirname(require.resolve("tailwindcss/package.json"));
const outputRoot = join(packageRoot, "dist", "tailwindcss");
const stylesheets = ["index.css", "theme.css", "preflight.css", "utilities.css"];

mkdirSync(outputRoot, { recursive: true });
for (const stylesheet of stylesheets) {
  copyFileSync(join(tailwindRoot, stylesheet), join(outputRoot, stylesheet));
}
