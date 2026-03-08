import { execFileSync, spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import path from "node:path";

const HOST = process.env.STREAM_MDX_GATE_HOST ?? "127.0.0.1";
const PORT = Number(process.env.STREAM_MDX_GATE_PORT ?? "3000");
const BASE_URL = `http://${HOST}:${PORT}`;
const TMP_DIR = path.resolve(process.cwd(), "tmp", "seeded-smoke");

function run(command: string, args: string[], options: { env?: NodeJS.ProcessEnv } = {}): void {
  execFileSync(command, args, {
    stdio: "inherit",
    env: { ...process.env, ...options.env },
  });
}

async function waitForServer(url: string, retries = 45, delayMs = 1500): Promise<void> {
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // ignore startup races
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(`Server at ${url} did not respond after ${retries} attempts`);
}

function startServer(): ReturnType<typeof spawn> {
  mkdirSync(TMP_DIR, { recursive: true });
  const logPath = path.join(TMP_DIR, "docs-dev.log");
  const logStream = createWriteStream(logPath, { flags: "a" });
  const child = spawn(
    "npm",
    ["-w", "stream-mdx-docs", "run", "dev", "--", "--hostname", HOST, "--port", String(PORT)],
    {
      env: {
        ...process.env,
        NEXT_PUBLIC_STREAMING_DEMO_API: "true",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.on("data", (chunk) => logStream.write(chunk));
  child.stderr.on("data", (chunk) => logStream.write(chunk));
  child.on("close", () => logStream.end());
  return child;
}

async function stopServer(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.killed) {
    return;
  }
  const waitForClose = (timeoutMs: number) =>
    new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      child.once("close", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  child.kill("SIGTERM");
  const closed = await waitForClose(5000);
  if (!closed) {
    child.kill("SIGKILL");
    await waitForClose(5000);
  }
}

async function main(): Promise<void> {
  let server: ReturnType<typeof spawn> | null = null;
  try {
    run("npm", ["run", "docs:worker:build"]);
    server = startServer();
    await waitForServer(`${BASE_URL}/regression/html`);
    run("npm", ["run", "test:regression:seeded-smoke"], {
      env: {
        STREAM_MDX_REGRESSION_BASE_URL: BASE_URL,
      },
    });
  } finally {
    if (server) {
      await stopServer(server);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
