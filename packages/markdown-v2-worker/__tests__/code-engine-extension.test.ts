import assert from "node:assert/strict";
import { STREAM_MDX_SCHEMA_VERSION, type WorkerOut } from "@stream-mdx/core";
import { MarkdownEngine, type CodeEngine } from "../src/engine";

async function workerCodeEngineExtensionReceivesCodeLines(): Promise<void> {
  const errors: string[] = [];
  const calls: Array<Parameters<CodeEngine["tokenizeLines"]>[0]> = [];
  const code: CodeEngine = {
    id: "worker-code-engine",
    tokenizeLines(request) {
      calls.push(request);
      const firstLine = typeof request.state === "number" ? request.state : 0;
      return {
        lines: request.lines.map((line, offset) => ({
          spans: [{ t: `worker:${request.language}:${firstLine + offset}:${line}` }],
        })),
        state: firstLine + request.lines.length,
      };
    },
  };
  const engine = new MarkdownEngine({
    post(message: WorkerOut) {
      if (message.type === "ERROR") errors.push(message.error.message);
    },
    extensions: { code },
  });

  try {
    await engine.handle({
      type: "INIT",
      schemaVersion: STREAM_MDX_SCHEMA_VERSION,
      initialContent: "```typescript\nconst workerCode = 1;\nconst second = 2;\n```\n",
      prewarmLangs: [],
      docPlugins: {
        footnotes: false,
        html: false,
        mdx: false,
        tables: false,
        math: false,
        callouts: false,
        codeHighlighting: "final",
        outputMode: "tokens",
        emitHighlightTokens: true,
        lazyTokenization: { enabled: false },
      },
    });
    await engine.handle({ type: "FINALIZE" });

    assert.deepEqual(
      calls.flatMap(({ language, lines }) => lines.map((line) => [language, line])),
      [
        ["typescript", "const workerCode = 1;"],
        ["typescript", "const second = 2;"],
      ],
      "the worker passes code lines to its configured adapter",
    );
    assert.deepEqual(errors, []);
  } finally {
    engine.dispose();
  }
}

await workerCodeEngineExtensionReceivesCodeLines();
console.log("worker code engine extension test passed");
