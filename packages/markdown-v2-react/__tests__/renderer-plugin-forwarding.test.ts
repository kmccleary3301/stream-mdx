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

function testPluginForwarding(): void {
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
    { footnotes: true, html: true, mdx: true, tables: true, callouts: true, math: true, formatAnticipation: true },
    "docPlugins must mirror renderer.feature flags",
  );
  assert.strictEqual(init?.mdx?.compileMode, "worker", "mdx compile mode should propagate to worker");

  renderer.detachWorker();
}

testPluginForwarding();
console.log("renderer plugin forwarding test passed");
