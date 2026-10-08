import assert from "node:assert";
import type { WorkerIn } from "@stream-mdx/core";
import { MarkdownRenderer } from "../src/renderer";

class MockWorker {
  public messages: WorkerIn[] = [];
  addEventListener(_type: string, _listener: (...args: unknown[]) => void): void {}
  removeEventListener(_type: string, _listener: (...args: unknown[]) => void): void {}
  postMessage(message: WorkerIn): void {
    this.messages.push(message);
  }
  terminate(): void {}
}

async function testPluginForwarding(): Promise<void> {
  const renderer = new MarkdownRenderer({
    plugins: { math: true, mdx: true, html: true, tables: true, callouts: true, formatAnticipation: true },
    mdx: { compileStrategy: "worker" },
  });
  const worker = new MockWorker();
  renderer.attachWorker(worker as unknown as Worker);

  const init = worker.messages.find((msg) => msg.type === "INIT");
  assert.ok(init, "Streaming renderer should send INIT message with docPlugins");
  assert.deepStrictEqual(
    init?.docPlugins,
    {
      footnotes: true,
      html: true,
      mdx: true,
      tables: true,
      callouts: true,
      math: true,
      formatAnticipation: true,
      liveCodeHighlighting: false,
    },
    "docPlugins must mirror renderer.feature flags",
  );
  assert.strictEqual(init?.mdx?.compileMode, "worker", "mdx compile mode should propagate to worker");
  const configured = new MarkdownRenderer({
    plugins: { outputMode: "tokens", liveTokenization: true, emitHighlightTokens: true, emitDiffBlocks: true },
    highlight: { langs: ["typescript"] },
    syntax: [{ name: "issue", pattern: { source: "#([A-Z]+-\\d+)" } }],
    html: { allowedTags: ["kbd"] },
  });
  const configuredWorker = new MockWorker();
  configured.attachWorker(configuredWorker as unknown as Worker);
  const configuredInit = configuredWorker.messages[0];
  assert.equal(configuredInit.type, "INIT");
  const cancelled = configured.renderStatic("# Static options");
  const rejection = assert.rejects(cancelled, /Worker detached/);
  assert.deepStrictEqual(configuredWorker.messages[1], { ...configuredInit, initialContent: "# Static options" },
    "static INIT shares the complete streaming initialization construction");
  configured.detachWorker();
  await rejection;

  renderer.restart();
  assert.strictEqual(worker.messages.filter((message) => message.type === "INIT").length, 1,
    "restarting an empty attached engine does not initialize it twice");
  renderer.append("Existing stream content");
  renderer.restart();
  assert.deepStrictEqual(worker.messages.at(-1), init, "restarting content reinitializes with the same plugin and MDX configuration");

  const managedRenderer = new MarkdownRenderer();
  const managedWorker = new MockWorker();
  managedRenderer.attachWorker(managedWorker as unknown as Worker, { skipInit: true });
  managedRenderer.append("Externally managed content");
  managedRenderer.restart();
  assert.strictEqual(managedWorker.messages.some((message) => message.type === "INIT"), false,
    "renderer restart never initializes an externally managed worker");
  managedRenderer.detachWorker();

  renderer.detachWorker();
}

await testPluginForwarding();
console.log("renderer plugin forwarding test passed");
