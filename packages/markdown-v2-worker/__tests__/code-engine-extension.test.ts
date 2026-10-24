import assert from "node:assert/strict";
import { STREAM_MDX_SCHEMA_VERSION, type WorkerOut } from "@stream-mdx/core";
import { MarkdownEngine, type CodeEngine } from "../src/engine";

type WorkerSnapshot = Extract<WorkerOut, { type: "INITIALIZED" }>["snapshot"];

function snapshotCodeTokenLines(node: WorkerSnapshot): string[][] {
  const lines = node.code?.lines.flatMap((line) => {
    const tokens = line.decoration?.tokens;
    return tokens ? [tokens.spans.map(({ t }) => t).join("")] : [];
  }) ?? [];
  return [...lines, ...(node.children ?? []).flatMap(snapshotCodeTokenLines)];
}

async function workerCodeEngineExtensionEmitsAdapterTokens(): Promise<void> {
  const errors: string[] = [];
  const messages: WorkerOut[] = [];
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
      messages.push(message);
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
        codeHighlighting: "incremental",
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
    const expectedTokens = [
      "worker:typescript:0:const workerCode = 1;",
      "worker:typescript:1:const second = 2;",
    ];
    const emittedTokenLines = messages.map((message) => {
      if (message.type === "INITIALIZED") return snapshotCodeTokenLines(message.snapshot);
      if (message.type === "PATCH") {
        return message.patches.flatMap((patch) => patch.op === "decorateCode"
          ? patch.decorations.flatMap(({ tokens }) => tokens
            ? [tokens.spans.map(({ t }) => t).join("")]
            : [])
          : []);
      }
      return [];
    }).filter((lines) => lines.length > 0);
    assert.ok(
      emittedTokenLines.some((lines) => lines.length === expectedTokens.length
        && lines.every((line, index) => line === expectedTokens[index])),
      `the worker emits configured adapter tokens in code-line records: ${JSON.stringify(emittedTokenLines)}`,
    );
  } finally {
    engine.dispose();
  }
}

await workerCodeEngineExtensionEmitsAdapterTokens();
console.log("worker code engine extension test passed");
