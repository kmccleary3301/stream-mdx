import assert from "node:assert/strict";
import type { CodeNodeHandle } from "@stream-mdx/core";
import { StreamingMarkdown, useCodeLines, type StreamingMarkdownHandle } from "@stream-mdx/react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

type CodeViewProps = { readonly handle: CodeNodeHandle };

function CodeView({ handle }: CodeViewProps): React.ReactElement {
  const lines = useCodeLines(handle, { from: 0, to: 4 });
  return (
    <pre data-code-engine-view>
      {lines.map((line) => (
        <span data-code-line={line.index} key={line.id}>
          {line.decoration && line.decoration.exactness !== "unavailable"
            ? line.decoration.tokens.spans.map((span) => span.t).join("")
            : line.text}
        </span>
      ))}
    </pre>
  );
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${message}`);
    await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 10)));
  }
}

async function mainCodeEngineUsesAdapterTokens(): Promise<void> {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    Worker: undefined,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const globalKeys = Object.keys(globals) as Array<keyof typeof globals>;
  const previousGlobals = Object.fromEntries(
    globalKeys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  ) as Record<keyof typeof globals, PropertyDescriptor | undefined>;
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }

  const container = dom.window.document.createElement("div");
  dom.window.document.body.append(container);
  const root = createRoot(container);
  const handle = React.createRef<StreamingMarkdownHandle>();
  const errors: Error[] = [];
  const calls: Array<{ language: string; lines: readonly string[]; state: unknown | null }> = [];
  const code = {
    id: "test-code-engine",
    tokenizeLines(request: { language: string; lines: readonly string[]; state: unknown | null }) {
      calls.push(request);
      const firstLine = typeof request.state === "number" ? request.state : 0;
      return {
        lines: request.lines.map((line, offset) => ({
          spans: [{ t: `adapter:${request.language}:${firstLine + offset}:${line}` }],
        })),
        state: firstLine + request.lines.length,
      };
    },
  };

  try {
    await act(async () => {
      root.render(
        <StreamingMarkdown
          ref={handle}
          engine="main"
          engines={{ code }}
          components={{ code: { view: CodeView } }}
          features={{ codeHighlighting: "incremental", html: false, mdx: false, tables: false, math: false }}
          caret={false}
          onError={(error) => errors.push(error)}
        />,
      );
    });
    await waitFor(() => handle.current?.getState().workerReady === true, "the main engine to become ready");
    const stream = handle.current;
    assert.ok(stream);

    await act(async () => {
      stream.append("```typescript\nconst adapter");
      stream.append("Token = 1;\nconst second = 2;\n```\n");
    });
    await waitFor(
      () => errors.length > 0
        || container.querySelector('[data-code-line="1"]')?.textContent?.startsWith("adapter:typescript:1:") === true,
      `adapter tokens for the split streamed code lines to render or the engine to report an error (DOM: ${container.innerHTML}; adapter calls: ${calls.length})`,
    );
    assert.deepEqual(errors, [], "the in-process engine initializes without errors");

    assert.deepEqual(
      Array.from(container.querySelectorAll("[data-code-line]"), (line) => line.textContent),
      [
        "adapter:typescript:0:const adapterToken = 1;",
        "adapter:typescript:1:const second = 2;",
      ],
      "native code renders only the configured adapter tokens",
    );
    assert.deepEqual(calls.map(({ language, lines }) => [language, ...lines]), [
      ["typescript", "const adapterToken = 1;", "const second = 2;"],
    ]);
    assert.equal(errors.length, 0);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    for (const key of globalKeys) {
      const descriptor = previousGlobals[key];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
}

function autoCodeEngineIsRejectedBeforeAcceptingSource(): void {
  const code = {
    id: "auto-code-engine",
    tokenizeLines({ lines }: { readonly lines: readonly string[] }) {
      return { lines: lines.map((line) => ({ spans: [{ t: line }] })), state: null };
    },
  };
  assert.throws(
    () => renderToStaticMarkup(
      <StreamingMarkdown engine="auto" text="source must not be accepted" engines={{ code }} />,
    ),
    (error: unknown) => error instanceof Error && error.name === "EngineCompatibilityError",
    "a main-realm CodeEngine rejects auto mode before source acceptance",
  );
}

autoCodeEngineIsRejectedBeforeAcceptingSource();
mainCodeEngineUsesAdapterTokens().then(
  () => console.log("code-engine test passed"),
  (error) => {
    console.error(error);
    process.exitCode = 1;
  },
);
