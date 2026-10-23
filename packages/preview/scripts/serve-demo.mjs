import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOST = "127.0.0.1";
const PORT = 3421;
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const previewModule = (path) => ({
  file: join(packageRoot, "dist", path),
  contentType: "text/javascript; charset=utf-8",
  cors: true,
});
const routes = new Map([
  ["/", { file: join(packageRoot, "src/demo/index.html"), contentType: "text/html; charset=utf-8" }],
  ["/demo.js", { file: join(packageRoot, "src/demo/demo.js"), contentType: "text/javascript; charset=utf-8" }],
  ["/preview/index.mjs", previewModule("index.mjs")],
  ["/preview/vendor/react-core.mjs", previewModule("vendor/react-core.mjs")],
  ["/preview/vendor/react.mjs", previewModule("vendor/react.mjs")],
  ["/preview/vendor/react-dom.mjs", previewModule("vendor/react-dom.mjs")],
  ["/preview/vendor/react-dom-client.mjs", previewModule("vendor/react-dom-client.mjs")],
  ["/preview/vendor/react-jsx-runtime.mjs", previewModule("vendor/react-jsx-runtime.mjs")],
  ["/preview/vendor/react-jsx-dev-runtime.mjs", previewModule("vendor/react-jsx-dev-runtime.mjs")],
  ["/preview/esbuild.wasm", { file: join(packageRoot, "dist/esbuild.wasm"), contentType: "application/wasm", cors: true }],
  ["/preview/tailwindcss/index.css", { file: join(packageRoot, "dist/tailwindcss/index.css"), contentType: "text/css; charset=utf-8" }],
  ["/preview/tailwindcss/theme.css", { file: join(packageRoot, "dist/tailwindcss/theme.css"), contentType: "text/css; charset=utf-8" }],
  ["/preview/tailwindcss/preflight.css", { file: join(packageRoot, "dist/tailwindcss/preflight.css"), contentType: "text/css; charset=utf-8" }],
  ["/preview/tailwindcss/utilities.css", { file: join(packageRoot, "dist/tailwindcss/utilities.css"), contentType: "text/css; charset=utf-8" }],
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
