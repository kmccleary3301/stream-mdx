// Stryker test runner with a pool of prewarmed children per runner slot. Every test file of every
// mutant runs in its own fresh process (the suite's per-file isolation; no mutable state crosses
// files or mutants), but module loading and TS compilation happen ahead of time while other runs
// execute. Test files are the "tests": per-file coverage lets Stryker skip uncovered mutants and
// run only the files that reach each mutant.
import { fork } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const childPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "child.mjs");

class StreamMdxHotRunner {
  static inject = ["options"];

  constructor(options) {
    const settings = options.streamMdxHot ?? {};
    if (!Array.isArray(settings.testFiles) || settings.testFiles.length === 0) {
      throw new Error("streamMdxHot.testFiles must list at least one test file");
    }
    this.testFiles = settings.testFiles.map((file) => path.resolve(file));
    this.execArgv = settings.execArgv ?? [];
    // Sandbox-relative files (resolved against the runner's sandbox cwd) and bare specifiers.
    this.preload = [
      ...(settings.preloadFiles ?? []).map((file) => pathToFileURL(path.resolve(file)).href),
      ...(settings.preload ?? []),
    ];
    this.env = settings.env ?? {};
    this.inheritOutput = settings.inheritOutput === true;
    // Warm children kept ready per runner slot; each test file of each mutant consumes one.
    this.poolSize = Math.max(1, settings.poolSize ?? 2);
    this.spares = [];
    // Dry-run duration per test file; mutant runs try the cheapest covering files first. Only one
    // runner process performs the dry run, so it shares the timings through `timingsFile`.
    this.timingsFile = settings.timingsFile;
    this.fileMs = undefined;
  }

  capabilities() {
    return { reloadEnvironment: true };
  }

  spawn(activeMutant) {
    const env = {
      ...process.env,
      ...this.env,
      STREAM_MDX_HOT_CHILD_CONFIG: JSON.stringify({ preload: this.preload, inheritOutput: this.inheritOutput }),
    };
    if (activeMutant === undefined) delete env.__STRYKER_ACTIVE_MUTANT__;
    else env.__STRYKER_ACTIVE_MUTANT__ = activeMutant;
    const child = fork(childPath, [], { cwd: process.cwd(), env, execArgv: this.execArgv, stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 16384) stderr += chunk;
    });
    const ready = new Promise((resolve, reject) => {
      child.on("message", (message) => {
        if (message.type === "ready") resolve();
        else if (message.type === "preload-error") reject(new Error(message.message));
      });
      child.once("exit", (code, signal) => reject(new Error(`child exited during preload (${signal ?? code})\n${stderr}`)));
    });
    ready.catch(() => {});
    return { child, ready, stderr: () => stderr };
  }

  /** Takes a warm child (or a fresh one with the mutant active before load) and refills the pool. */
  take(staticMutant) {
    const worker = staticMutant === undefined ? (this.spares.shift() ?? this.spawn(undefined)) : this.spawn(staticMutant);
    while (this.spares.length < this.poolSize) this.spares.push(this.spawn(undefined));
    return worker;
  }

  /** Runs ONE test file in its own process, preserving the suite's per-file process isolation. */
  async runFile(file, request, timeout, staticMutant) {
    const worker = this.take(staticMutant);
    try {
      await worker.ready;
    } catch (error) {
      return { kind: "crash", reason: error.message };
    }
    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        worker.child.kill("SIGKILL");
        resolve({ kind: "timeout" });
      }, timeout);
      worker.child.on("message", (message) => {
        if (message.type === "done") {
          clearTimeout(timer);
          resolve({ kind: "done", result: message.results[0], mutantCoverage: message.mutantCoverage });
        }
      });
      worker.child.once("exit", (code, signal) => {
        clearTimeout(timer);
        resolve({ kind: "crash", reason: `child exited (${signal ?? code})\n${worker.stderr()}` });
      });
      worker.child.send({ ...request, files: [file] });
    });
  }

  async init() {
    while (this.spares.length < this.poolSize) this.spares.push(this.spawn(undefined));
    await Promise.all(this.spares.map((spare) => spare.ready));
  }

  async dryRun(options) {
    const collectCoverage = options.coverageAnalysis !== "off";
    const tests = [];
    const coverage = { static: {}, perTest: {} };
    const timings = {};
    for (const file of this.testFiles) {
      const outcome = await this.runFile(file, { collectCoverage, bail: false }, Math.max(options.timeout, 60_000), undefined);
      if (outcome.kind === "timeout") return { status: "timeout", reason: `dry run timed out in ${file}` };
      if (outcome.kind === "crash") return { status: "error", errorMessage: `${file}: ${outcome.reason}` };
      const { result, mutantCoverage } = outcome;
      timings[file] = result.ms;
      tests.push({
        id: file,
        name: path.relative(process.cwd(), file),
        fileName: file,
        timeSpentMs: Math.round(result.ms),
        ...(result.ok ? { status: 0 } : { status: 1, failureMessage: result.failure }),
      });
      if (mutantCoverage) {
        // Every child preloads the same modules, so static hits repeat; keep the maximum.
        for (const [id, hits] of Object.entries(mutantCoverage.static)) coverage.static[id] = Math.max(coverage.static[id] ?? 0, hits);
        Object.assign(coverage.perTest, mutantCoverage.perTest);
      }
    }
    if (this.timingsFile) writeFileSync(this.timingsFile, JSON.stringify(timings));
    return { status: "complete", tests, ...(collectCoverage ? { mutantCoverage: coverage } : {}) };
  }

  fileOrder() {
    if (this.fileMs === undefined) {
      const timings = this.timingsFile && existsSync(this.timingsFile) ? JSON.parse(readFileSync(this.timingsFile, "utf8")) : {};
      this.fileMs = new Map(Object.entries(timings));
    }
    return (a, b) => (this.fileMs.get(a) ?? 0) - (this.fileMs.get(b) ?? 0);
  }

  async mutantRun(options) {
    const filter = options.testFilter ? new Set(options.testFilter) : undefined;
    const files = (filter ? this.testFiles.filter((file) => filter.has(file)) : [...this.testFiles]).sort(this.fileOrder());
    const staticActivation = options.mutantActivation === "static" || options.reloadEnvironment;
    const request = {
      activeMutant: staticActivation ? undefined : options.activeMutant.id,
      hitLimit: options.hitLimit,
      bail: true,
    };
    const deadline = Date.now() + options.timeout;
    let ran = 0;
    let firstFailure;
    for (const file of files) {
      const outcome = await this.runFile(file, request, Math.max(1, deadline - Date.now()), staticActivation ? options.activeMutant.id : undefined);
      ran += 1;
      if (outcome.kind === "timeout") return { status: "timeout", reason: `timed out in ${file}` };
      const failure = outcome.kind === "crash" ? outcome.reason : outcome.result.ok ? undefined : outcome.result.failure;
      if (failure === undefined) continue;
      if (failure.includes("Stryker: Hit count limit reached")) return { status: "timeout", reason: failure };
      firstFailure ??= { id: file, failure };
      if (!options.disableBail) break;
    }
    if (firstFailure) {
      return { status: "killed", killedBy: [firstFailure.id], failureMessage: firstFailure.failure, nrOfTests: ran };
    }
    return { status: "survived", nrOfTests: ran };
  }

  async dispose() {
    for (const spare of this.spares) spare.child.kill("SIGKILL");
    this.spares = [];
  }
}

export const strykerPlugins = [{ kind: "TestRunner", name: "stream-mdx-hot", injectableClass: StreamMdxHotRunner }];
