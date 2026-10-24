// One mutant per process: the parent spawns this child ahead of time, the child preloads the
// configured modules (compiled code, grammars) with no mutant active, then waits for exactly one
// run request. Mutable module state therefore never crosses mutants; only warm-up latency is hidden.
import { pathToFileURL } from "node:url";

const ns = globalThis.__stryker__ || (globalThis.__stryker__ = {});
const config = JSON.parse(process.env.STREAM_MDX_HOT_CHILD_CONFIG ?? "{}");
const output = [];
const OUTPUT_LIMIT = 64 * 1024;
let outputBytes = 0;

function capture(stream) {
  const write = stream.write.bind(stream);
  stream.write = (chunk, ...rest) => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    if (outputBytes < OUTPUT_LIMIT) {
      output.push(text);
      outputBytes += text.length;
    }
    if (config.inheritOutput) return write(chunk, ...rest);
    const callback = rest.find((value) => typeof value === "function");
    if (callback) callback();
    return true;
  };
}
capture(process.stdout);
capture(process.stderr);

// Some test files end with process.exit(code) to drop lingering handles. Within one child several
// files run in sequence, so exit becomes a thrown signal: code 0 completes the file, others fail it.
class ExitSignal extends Error {
  constructor(code) {
    super(`test file called process.exit(${code})`);
    this.code = code;
  }
}
const realExit = process.exit.bind(process);
process.exit = (code = process.exitCode ?? 0) => {
  throw new ExitSignal(Number(code));
};

let asyncFailure;
process.on("unhandledRejection", (reason) => {
  if (reason instanceof ExitSignal && reason.code === 0) return;
  asyncFailure ??= reason instanceof Error ? reason : new Error(String(reason));
});
process.on("uncaughtException", (error) => {
  if (error instanceof ExitSignal && error.code === 0) return;
  asyncFailure ??= error;
});

function describe(error) {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

async function runFile(file) {
  asyncFailure = undefined;
  process.exitCode = 0;
  const started = performance.now();
  try {
    await import(pathToFileURL(file).href);
    // Let rejected promises created on the file's last turn surface before judging it.
    await new Promise((resolve) => setImmediate(resolve));
    if (asyncFailure) throw asyncFailure;
    if (process.exitCode !== 0 && process.exitCode !== undefined) {
      throw new Error(`test file set process.exitCode=${process.exitCode}\n${output.join("").slice(-4096)}`);
    }
    return { id: file, ok: true, ms: performance.now() - started };
  } catch (error) {
    if (error instanceof ExitSignal && error.code === 0 && !asyncFailure) {
      return { id: file, ok: true, ms: performance.now() - started };
    }
    return { id: file, ok: false, ms: performance.now() - started, failure: describe(asyncFailure ?? error) };
  } finally {
    process.exitCode = 0;
  }
}

async function run(request) {
  if (request.activeMutant !== undefined) ns.activeMutant = request.activeMutant;
  if (request.hitLimit !== undefined) {
    ns.hitLimit = request.hitLimit;
    ns.hitCount = 0;
  }
  if (request.collectCoverage) ns.mutantCoverage ??= { static: {}, perTest: {} };
  const results = [];
  for (const file of request.files) {
    if (request.collectCoverage) ns.currentTestId = file;
    process.send({ type: "file", id: file });
    const result = await runFile(file);
    results.push(result);
    if (request.collectCoverage) ns.currentTestId = undefined;
    if (!result.ok && request.bail) break;
  }
  return { results, mutantCoverage: request.collectCoverage ? ns.mutantCoverage : undefined };
}

try {
  for (const specifier of config.preload ?? []) await import(specifier);
  process.send({ type: "ready" });
} catch (error) {
  process.send({ type: "preload-error", message: describe(error) });
  realExit(1);
}

process.once("message", async (request) => {
  const response = await run(request);
  process.send({ type: "done", ...response }, () => realExit(0));
});
