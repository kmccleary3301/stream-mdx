/** @type {import("next").NextConfig} */
import path from "node:path";
import { fileURLToPath } from "node:url";

const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const nextConfig = {
  reactStrictMode: true,
  outputFileTracingRoot: path.resolve(__dirname, "../../.."),
  output: "export",
  trailingSlash: true,
  basePath: basePath || undefined,
  assetPrefix: basePath || undefined,
  images: { unoptimized: true },
  webpack(config) {
    config.resolve.alias = {
      ...(config.resolve.alias ?? {}),
      streamdown: path.resolve(__dirname, "../../node_modules/streamdown/dist/index.js"),
    };
    return config;
  },
};

export default nextConfig;
