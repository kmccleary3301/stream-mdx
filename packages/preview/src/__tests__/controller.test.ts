import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { createEsbuildCompiler, createPreviewController, createPreviewVariantsController } from "../index";
import type {
  CompiledPreview,
  PreviewCandidate,
  PreviewClock,
  PreviewInput,
  PreviewTransport,
  TailwindStylesheetName,
} from "../index";

const require = createRequire(import.meta.url);
const tailwindPackage = dirname(require.resolve("tailwindcss/package.json"));

function loadTailwindStylesheet(name: TailwindStylesheetName): Promise<string> {
  return readFile(join(tailwindPackage, name), "utf8");
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

class TestClock implements PreviewClock {
  #time = 0;
  #nextId = 0;
  #tasks = new Map<number, { at: number; callback: () => void }>();

  now(): number {
    return this.#time;
  }

  schedule(callback: () => void, delayMs: number): () => void {
    const id = ++this.#nextId;
    this.#tasks.set(id, { at: this.#time + delayMs, callback });
    return () => this.#tasks.delete(id);
  }

  advanceBy(delayMs: number): void {
    this.#time += delayMs;
    const due = [...this.#tasks.entries()]
      .filter(([, task]) => task.at <= this.#time)
      .sort((left, right) => left[1].at - right[1].at);
    for (const [id, task] of due) {
      this.#tasks.delete(id);
      task.callback();
    }
  }
}

class RecordingTransport implements PreviewTransport {
  generations: string[] = [];
  published: PreviewCandidate[] = [];
  disposed = false;
  styleUpdates: Array<{
    identity: PreviewCandidate["identity"];
    candidateId: number;
    css: string;
  }> = [];
  failRevision: string | null = null;

  beginGeneration(generation: string): void {
    this.generations.push(generation);
  }

  requested(): void {}

  async publish(candidate: PreviewCandidate, isCurrent: () => boolean): Promise<boolean> {
    if (!isCurrent()) return false;
    if (candidate.identity.revision === this.failRevision) throw new Error("frame render failure");
    this.published.push(candidate);
    return true;
  }
  async updateStyles(
    update: { identity: PreviewCandidate["identity"]; candidateId: number; css: string },
    isCurrent: () => boolean,
  ): Promise<boolean> {
    if (!isCurrent()) return false;
    this.styleUpdates.push(update);
    return true;
  }

  dispose(): void {
    this.disposed = true;
  }
}

function project(generation: string, revision: string): PreviewInput {
  return {
    generation,
    revision,
    entry: "main.tsx",
    files: new Map([["main.tsx", `export const revision = ${JSON.stringify(revision)};`]]),
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

test("preview revisions reject stale work, preserve visible identity, coalesce, and dispose", async () => {
  const clock = new TestClock();
  const transport = new RecordingTransport();
  const staleCompilation = deferred<CompiledPreview>();
  const controller = createPreviewController({
    clock,
    transport,
    compile(input) {
      if (input.revision === "stale") return staleCompilation.promise;
      if (input.revision === "broken") return Promise.reject(new Error("syntax error"));
      return Promise.resolve({ javascript: `// ${input.revision}` });
    },
  });

  const staleRequest = controller.request(project("document-1", "stale"));
  const newestRequest = controller.request(project("document-1", "newest"));
  staleCompilation.resolve({ javascript: "// stale output" });
  await Promise.all([staleRequest, newestRequest]);
  await flushMicrotasks();
  assert.deepEqual(
    transport.published.map(({ identity }) => identity),
    [{ generation: "document-1", revision: "newest" }],
    "a completed older compile must not become visible after a newer request",
  );

  await controller.request(project("document-1", "broken"));
  assert.deepEqual(controller.getState().visible, { generation: "document-1", revision: "newest" });
  assert.deepEqual(controller.getState().error?.identity, {
    generation: "document-1",
    revision: "broken",
  });

  const nextGeneration = controller.request(project("document-2", "first"));
  assert.equal(controller.getState().visible, null, "a new generation starts without the old visible candidate");
  await nextGeneration;
  clock.advanceBy(250);
  await flushMicrotasks();
  const latestPublication = transport.published[transport.published.length - 1];
  assert.deepEqual(transport.generations, ["document-1", "document-2"]);
  assert.deepEqual(latestPublication?.identity, {
    generation: "document-2",
    revision: "first",
  });
  assert.deepEqual(controller.getState().visible, { generation: "document-2", revision: "first" });
  controller.dispose();

  const runtimeErrorTransport = new RecordingTransport();
  runtimeErrorTransport.failRevision = "render-error";
  const runtimeErrorController = createPreviewController({
    transport: runtimeErrorTransport,
    compile(input) {
      return Promise.resolve({ javascript: `// ${input.revision}` });
    },
  });
  await runtimeErrorController.request(project("document-runtime-error", "last-valid"));
  await flushMicrotasks();
  await runtimeErrorController.request(project("document-runtime-error", "render-error"));
  await flushMicrotasks();
  assert.deepEqual(runtimeErrorController.getState().visible, {
    generation: "document-runtime-error",
    revision: "last-valid",
  });
  assert.deepEqual(runtimeErrorController.getState().error?.identity, {
    generation: "document-runtime-error",
    revision: "render-error",
  });
  assert.equal(runtimeErrorController.getState().error?.message, "frame render failure");
  runtimeErrorController.dispose();

  const rateClock = new TestClock();
  const rateTransport = new RecordingTransport();
  const rateController = createPreviewController({
    clock: rateClock,
    transport: rateTransport,
    compile(input) {
      return Promise.resolve({ javascript: `// ${input.revision}` });
    },
  });
  for (let index = 1; index <= 4; index += 1) {
    await rateController.request(project("document-rate", `base-${index}`));
    await flushMicrotasks();
  }
  await rateController.request(project("document-rate", "middle"));
  await rateController.request(project("document-rate", "newest"));
  rateClock.advanceBy(1000);
  await flushMicrotasks();
  assert.deepEqual(
    rateTransport.published.map(({ identity }) => identity.revision),
    ["base-1", "base-2", "base-3", "base-4", "newest"],
  );
  rateController.dispose();

  const lateCompilation = deferred<CompiledPreview>();
  const disposalTransport = new RecordingTransport();
  let compileCalls = 0;
  const disposalController = createPreviewController({
    transport: disposalTransport,
    compile() {
      compileCalls += 1;
      return lateCompilation.promise;
    },
  });
  const lateRequest = disposalController.request(project("document-dispose", "late"));
  disposalController.dispose();
  await disposalController.request(project("document-dispose", "after-dispose"));
  lateCompilation.resolve({ javascript: "// late" });
  await lateRequest;
  await flushMicrotasks();
  assert.equal(disposalTransport.published.length, 0, "disposed controllers do not publish late compiler results");
  assert.equal(compileCalls, 1, "disposed controllers do not start more compilations");
  assert.equal(disposalTransport.disposed, true);
});
function multiFileProject(generation: string, revision: string): PreviewInput {
  return {
    generation,
    revision,
    entry: "src/main.tsx",
    files: new Map([
      [
        "src/main.tsx",
        [
          'import { Button } from "./components";',
          'import { add } from "../lib/util";',
          'import javascriptValue from "./javascript";',
          'import jsxValue from "./jsx";',
          'import config from "./data/config";',
          'import "./styles";',
          "export function App() {",
          "  return <Button label={`${add(config.base, 2)}:${javascriptValue}:${jsxValue}`} />;",
          "}",
        ].join("\n"),
      ],
      ["src/components/index.tsx", 'export { Button } from "./Button";'],
      [
        "src/components/Button.tsx",
        'export function Button({ label }: { label: string }) { return <button className="multi-file">{label}</button>; }',
      ],
      ["src/javascript/index.js", 'export default "from-js";'],
      ["src/jsx/index.jsx", 'export default "from-jsx";'],
      ["src/data/config.json", '{"base":40}'],
      ["src/styles.css", ".multi-file { color: rgb(12, 34, 56); }"],
      ["lib/util.ts", "export function add(left: number, right: number) { return left + right; }"],
    ]),
  };
}

test("preview compiler bundles nested local TSX, TS, JS, JSX, JSON, and CSS imports", async () => {
  const transport = new RecordingTransport();
  const compiler = createEsbuildCompiler({
    wasmURL: new URL("../../dist/esbuild.wasm", import.meta.url),
  });
  const controller = createPreviewController({ transport, compile: compiler });

  await controller.request(multiFileProject("multi-file", "first"));

  assert.deepEqual(
    controller.getState().visible,
    { generation: "multi-file", revision: "first" },
    controller.getState().error?.message,
  );
  assert.match(transport.published[0]?.javascript ?? "", /from-js/);
  assert.match(transport.published[0]?.javascript ?? "", /from-jsx/);
  assert.match(transport.published[0]?.css ?? "", /rgb\(12, 34, 56\)/);
  controller.dispose();
});

test("unresolved local imports name their importer and keep the last valid preview", async () => {
  const transport = new RecordingTransport();
  const compiler = createEsbuildCompiler({
    wasmURL: new URL("../../dist/esbuild.wasm", import.meta.url),
  });
  const controller = createPreviewController({ transport, compile: compiler });
  const valid = multiFileProject("import-error", "valid");
  await controller.request(valid);

  const brokenFiles = new Map(valid.files);
  brokenFiles.set(
    "src/components/Button.tsx",
    'import { missing } from "./missing"; export function Button() { return missing; }',
  );
  await controller.request({ ...valid, revision: "broken", files: brokenFiles });

  assert.deepEqual(controller.getState().visible, {
    generation: "import-error",
    revision: "valid",
  });
  assert.match(
    controller.getState().error?.message ?? "",
    /Preview project import "\.\/missing" from "src\/components\/Button\.tsx" was not found/,
  );
  controller.dispose();
});

test("CSS-only revisions publish styles in place while code revisions publish a fresh candidate", async () => {
  const transport = new RecordingTransport();
  const controller = createPreviewController({
    transport,
    async compile(input) {
      return {
        javascript: input.files.get("App.tsx") ?? "",
        css: input.files.get("styles.css") ?? "",
      };
    },
  });
  const base: PreviewInput = {
    generation: "style-lifecycle",
    revision: "base",
    entry: "App.tsx",
    files: new Map([
      ["App.tsx", 'export const label = "base";'],
      ["styles.css", ".card { color: red; }"],
    ]),
  };
  await controller.request(base);
  await flushMicrotasks();

  const styleFiles = new Map(base.files);
  styleFiles.set("styles.css", ".card { color: blue; }");
  await controller.request({ ...base, revision: "styles", files: styleFiles });
  await flushMicrotasks();

  assert.deepEqual(
    transport.published.map(({ identity }) => identity.revision),
    ["base"],
  );
  assert.equal(transport.styleUpdates.length, 1);
  assert.deepEqual(controller.getState().styleResult, {
    kind: "styles-updated",
    identity: { generation: "style-lifecycle", revision: "styles" },
  });
  assert.deepEqual(controller.getState().visible, {
    generation: "style-lifecycle",
    revision: "styles",
  });

  const codeFiles = new Map(styleFiles);
  codeFiles.set("App.tsx", 'export const label = "changed";');
  await controller.request({ ...base, revision: "code", files: codeFiles });
  await flushMicrotasks();
  assert.deepEqual(
    transport.published.map(({ identity }) => identity.revision),
    ["base", "code"],
  );
  assert.equal(controller.getState().styleResult, null);
  assert.deepEqual(controller.getState().visible, {
    generation: "style-lifecycle",
    revision: "code",
  });
  controller.dispose();
});

test("local Tailwind utilities and preflight are emitted as frame CSS", async () => {
  const transport = new RecordingTransport();
  const controller = createPreviewController({
    transport,
    compile: createEsbuildCompiler({
      wasmURL: new URL("../../dist/esbuild.wasm", import.meta.url),
      loadTailwindStylesheet,
    }),
  });
  const projectInput = multiFileProject("tailwind-project", "initial");
  const files = new Map(projectInput.files);
  files.set(
    "src/components/Button.tsx",
    'export function Button({ label }: { label: string }) { return <button className="text-red-500 p-4">{label}</button>; }',
  );
  files.set("src/styles.css", '@import "tailwindcss";');
  await controller.request({ ...projectInput, files });
  await flushMicrotasks();

  const state = controller.getState();
  assert.equal(state.error, null, state.error?.message);
  assert.match(transport.published[0]?.css ?? "", /\.text-red-500/);
  assert.match(transport.published[0]?.css ?? "", /box-sizing:\s*border-box/);
  assert.doesNotMatch(transport.published[0]?.javascript ?? "", /box-sizing:\s*border-box/);
  controller.dispose();
});

test("preview variants keep independent state and cap simultaneous frames", async () => {
  const transports = new Map<string, RecordingTransport>();
  const variants = createPreviewVariantsController({
    variants: [{ name: "Cool" }, { name: "Warm" }],
    createController(variant, onState) {
      const transport = new RecordingTransport();
      transports.set(variant.name, transport);
      return createPreviewController({
        transport,
        compile: async () => ({
          javascript: `export const variant = ${JSON.stringify(variant.name)};`,
          css: `.variant { --accent: ${variant.name}; }`,
        }),
        onState,
      });
    },
  });

  const first = project("variants", "first");
  const files = new Map(first.files);
  files.set("styles.css", ".variant { color: red; }");
  await variants.request({ ...first, files });
  await flushMicrotasks();
  assert.deepEqual([...variants.getStates().keys()], ["Cool", "Warm"]);
  assert.deepEqual(variants.getState("Cool")?.visible, { generation: "variants", revision: "first" });
  assert.deepEqual(variants.getState("Warm")?.visible, { generation: "variants", revision: "first" });
  assert.equal(transports.get("Cool")?.published.length, 1);
  assert.equal(transports.get("Warm")?.published.length, 1);

  const styleFiles = new Map(files);
  styleFiles.set("styles.css", ".variant { color: blue; }");
  await variants.request({ ...first, revision: "styles", files: styleFiles });
  await flushMicrotasks();
  assert.deepEqual(variants.getState("Cool")?.visible, { generation: "variants", revision: "styles" });
  assert.deepEqual(variants.getState("Warm")?.visible, { generation: "variants", revision: "styles" });
  assert.equal(transports.get("Cool")?.styleUpdates.length, 1);
  assert.equal(transports.get("Warm")?.styleUpdates.length, 1);

  const codeFiles = new Map(styleFiles);
  codeFiles.set("main.tsx", 'export const code = "changed";');
  await variants.request({ ...first, revision: "code", files: codeFiles });
  await flushMicrotasks();
  assert.deepEqual(variants.getState("Cool")?.visible, { generation: "variants", revision: "code" });
  assert.deepEqual(variants.getState("Warm")?.visible, { generation: "variants", revision: "code" });
  assert.equal(transports.get("Cool")?.published.length, 2);
  assert.equal(transports.get("Warm")?.published.length, 2);
  assert.equal(transports.get("Cool")?.styleUpdates.length, 1);
  assert.equal(transports.get("Warm")?.styleUpdates.length, 1);
  assert.throws(
    () =>
      createPreviewVariantsController({
        variants: Array.from({ length: 5 }, (_, index) => ({ name: `Variant ${index}` })),
        createController: () => {
          throw new Error("must not construct an over-limit variant");
        },
      }),
    /1 and 4/,
  );

  variants.dispose();
  assert.equal(transports.get("Cool")?.disposed, true);
  assert.equal(transports.get("Warm")?.disposed, true);
});
