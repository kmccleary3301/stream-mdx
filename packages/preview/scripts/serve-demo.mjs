import { createServer } from "node:http";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOST = "127.0.0.1";
const PORT = 3421;
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const esbuildRoot = dirname(require.resolve("esbuild-wasm/package.json"));
const tailwindRoot = dirname(require.resolve("tailwindcss/package.json"));
const previewModule = (path) => ({
  file: join(packageRoot, "dist", path),
  contentType: "text/javascript; charset=utf-8",
  cors: true,
});
const dependencyModule = (root, path, contentType = "text/javascript; charset=utf-8") => ({
  file: join(root, path),
  contentType,
  cors: true,
});
const routes = new Map([
  ["/", { file: join(packageRoot, "src/demo/index.html"), contentType: "text/html; charset=utf-8" }],
  ["/demo.js", { file: join(packageRoot, "src/demo/demo.js"), contentType: "text/javascript; charset=utf-8" }],
  ["/preview/deps/esbuild-wasm.mjs", {
    file: join(packageRoot, "src/demo/esbuild-wasm-adapter.mjs"),
    contentType: "text/javascript; charset=utf-8",
    cors: true,
  }],
  ["/preview/deps/esbuild-wasm/lib/browser.js", dependencyModule(esbuildRoot, "lib/browser.js")],
  ["/preview/deps/esbuild-wasm/esbuild.wasm", dependencyModule(esbuildRoot, "esbuild.wasm", "application/wasm")],
  ["/preview/deps/tailwindcss/dist/lib.mjs", dependencyModule(tailwindRoot, "dist/lib.mjs")],
  ["/preview/deps/tailwindcss/dist/chunk-CT46QCH7.mjs", dependencyModule(tailwindRoot, "dist/chunk-CT46QCH7.mjs")],
  ["/preview/deps/tailwindcss/dist/chunk-GFBUASX3.mjs", dependencyModule(tailwindRoot, "dist/chunk-GFBUASX3.mjs")],
  ["/preview/deps/tailwindcss/dist/chunk-HTB5LLOP.mjs", dependencyModule(tailwindRoot, "dist/chunk-HTB5LLOP.mjs")],
  ["/preview/index.mjs", previewModule("index.mjs")],
  ["/preview/vendor/react-core.mjs", previewModule("vendor/react-core.mjs")],
  ["/preview/vendor/react.mjs", previewModule("vendor/react.mjs")],
  ["/preview/vendor/react-dom.mjs", previewModule("vendor/react-dom.mjs")],
  ["/preview/vendor/react-dom-client.mjs", previewModule("vendor/react-dom-client.mjs")],
  ["/preview/vendor/react-jsx-runtime.mjs", previewModule("vendor/react-jsx-runtime.mjs")],
  ["/preview/vendor/react-jsx-dev-runtime.mjs", previewModule("vendor/react-jsx-dev-runtime.mjs")],
  ["/preview/deps/tailwindcss/index.css", dependencyModule(tailwindRoot, "index.css", "text/css; charset=utf-8")],
  ["/preview/deps/tailwindcss/theme.css", dependencyModule(tailwindRoot, "theme.css", "text/css; charset=utf-8")],
  ["/preview/deps/tailwindcss/preflight.css", dependencyModule(tailwindRoot, "preflight.css", "text/css; charset=utf-8")],
  ["/preview/deps/tailwindcss/utilities.css", dependencyModule(tailwindRoot, "utilities.css", "text/css; charset=utf-8")],
]);

const server = createServer(async (request, response) => {
  if (request.method !== "GET") {
    response.writeHead(405, { Allow: "GET", "X-Content-Type-Options": "nosniff" });
    response.end("Method not allowed");
    return;
  }

  const pathname = new URL(request.url ?? "/", `http://${HOST}:${PORT}`).pathname;
  const route = routes.get(pathname);
  if (route === undefined) {
    response.writeHead(404, { "X-Content-Type-Options": "nosniff" });
    response.end("Not found");
    return;
  }

  try {
    const body = await readFile(route.file);
    const headers = {
      "Content-Length": body.byteLength,
      "Content-Type": route.contentType,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    };
    if (route.cors === true) {
      headers["Access-Control-Allow-Origin"] = "*";
      headers["Cross-Origin-Resource-Policy"] = "cross-origin";
    }
    response.writeHead(200, headers);
    response.end(body);
  } catch {
    response.writeHead(503, {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    response.end("Preview assets are not built. Run the @stream-mdx/preview build first.");
  }
});

server.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
server.listen(PORT, HOST, () => {
  console.log(`StreamMDX local preview: http://${HOST}:${PORT}`);
});
