import { execFileSync, spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import path from "node:path";

const HOST = process.env.STREAM_MDX_GATE_HOST ?? "127.0.0.1";
const PORT = Number(process.env.STREAM_MDX_GATE_PORT ?? "3000");
const BASE_URL = `http://${HOST}:${PORT}`;
const TMP_DIR = path.resolve(process.cwd(), "tmp", "release-gates");
const LOG_PATH = path.join(TMP_DIR, "docs-server.log");

function run(command: string, args: string[], options: { env?: Record<string, string | undefined> } = {}): void {
  execFileSync(command, args, {
    stdio: "inherit",
    env: { ...process.env, ...options.env },
  });
}

async function waitForServer(
  url: string,
  child: ReturnType<typeof spawn>,
  retries = 30,
  delayMs = 2000,
): Promise<void> {
  for (let attempt = 0; attempt < retries; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Static docs server exited before readiness check completed (exit ${child.exitCode}). Log: ${LOG_PATH}`);
    }
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // ignore
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(`Server at ${url} did not respond after ${retries} attempts. Log: ${LOG_PATH}`);
}

function startServer(): ReturnType<typeof spawn> {
  mkdirSync(TMP_DIR, { recursive: true });
  const logStream = createWriteStream(LOG_PATH, { flags: "a" });
  const child = spawn(
    "python3",
    ["-m", "http.server", String(PORT), "--bind", HOST],
    {
      cwd: path.resolve(process.cwd(), "apps/docs/out"),
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
    run("npm", ["run", "test:benchmarks:methodology"]);
    run("npm", ["run", "docs:check-links"], {
      env: {
        DOCS_CHECK_ANCHORS: "1",
      },
    });
    run("npm", ["run", "docs:build"]);
    server = startServer();
    await waitForServer(`${BASE_URL}/regression/html/`, server);

    run("npm", ["run", "test:snippets"], {
      env: {
        SNIPPET_TEST_URL: `${BASE_URL}/regression/snippet-test`,
      },
    });

    run("npm", ["run", "test:regression"], {
      env: {
        STREAM_MDX_REGRESSION_BASE_URL: BASE_URL,
      },
    });

    run("npm", ["run", "test:regression:seeded-smoke"], {
      env: {
        STREAM_MDX_REGRESSION_BASE_URL: BASE_URL,
      },
    });

    run("npm", ["run", "test:regression:scheduler-parity"], {
      env: {
        STREAM_MDX_REGRESSION_BASE_URL: BASE_URL,
      },
    });

    run("npm", ["run", "docs:quality:audit"], {
      env: {
        DOCS_AUDIT_BASE_URL: BASE_URL,
      },
    });

    run("npm", ["run", "perf:demo", "--", "--rate", "12000", "--tick", "5", "--runs", "1"], {
      env: {
        STREAM_MDX_PERF_BASE_URL: BASE_URL,
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
  console.error(`release-gates server log: ${LOG_PATH}`);
  process.exit(1);
});
