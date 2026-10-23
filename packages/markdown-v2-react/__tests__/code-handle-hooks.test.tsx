import assert from "node:assert/strict";
import type { CodeBlockSourceMetadata, CodeLineRecord, CodeNodeHandle } from "@stream-mdx/core";
import { useCodeBlock, useCodeLines } from "@stream-mdx/react";
import { createCodeDocument } from "@stream-mdx/worker/engine";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

type CodeRange = { readonly from: number; readonly to: number };
type ViewId = "narrow" | "wide";
type CodeBlockMetadata = Pick<CodeBlockSourceMetadata, "state" | "lineCount"> & {
  readonly info: string;
  readonly language?: string;
  readonly configurationRevision: number;
};
type ViewSnapshot = {
  readonly metadata: CodeBlockMetadata;
  readonly lines: readonly CodeLineRecord[];
};
type CapturedViews = Partial<Record<ViewId, ViewSnapshot>>;

type CodeDocumentViewProps = {
  readonly id: ViewId;
  readonly handle: CodeNodeHandle;
  readonly range: CodeRange;
  readonly capture: (id: ViewId, snapshot: ViewSnapshot) => void;
};


function CodeDocumentView({ id, handle, range, capture }: CodeDocumentViewProps): React.ReactElement {
  const metadata = useCodeBlock(handle);
  const lines = useCodeLines(handle, range);
  capture(id, { metadata, lines });

  return (
    <section
      data-code-view={id}
      data-state={metadata.state}
      data-line-count={metadata.lineCount}
      data-info={metadata.info}
      data-language={metadata.language}
      data-configuration-revision={metadata.configurationRevision}
    >
      {lines.map((line) => {
        const tokens = line.decoration && line.decoration.exactness !== "unavailable"
          ? line.decoration.tokens.spans
          : undefined;
        return (
          <div
            key={line.id}
            data-line-index={line.index}
            data-line-text={line.text}
            data-exactness={line.decoration?.exactness ?? "none"}
          >
            {tokens
              ? tokens.map((token, tokenIndex) => <span data-token key={`${line.id}:${tokenIndex}`}>{token.t}</span>)
              : line.text}
          </div>
        );
      })}
    </section>
  );
}

function readView(container: HTMLElement, id: ViewId): HTMLElement {
  const view = container.querySelector<HTMLElement>(`[data-code-view="${id}"]`);
  assert.ok(view, `missing ${id} code view`);
  return view;
}

function readLine(view: HTMLElement, index: number): HTMLElement {
  const line = view.querySelector<HTMLElement>(`[data-line-index="${index}"]`);
  assert.ok(line, `missing rendered code line ${index}`);
  return line;
}

async function runCodeHandleHooksTest(): Promise<void> {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previousGlobals = new Map(
    Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const),
  );
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }

  const initialSource = "const first = 1;\r\n";
  const appendedSource = "const second = 2;\r\nconst third = 3;";
  const tailAppend = " // continued";
  const selectedRange: CodeRange = { from: 0, to: 1 };
  const expandedRange: CodeRange = { from: 0, to: 3 };
  const controller = createCodeDocument({ language: "typescript", initialContent: initialSource });
  const container = dom.window.document.createElement("div");
  dom.window.document.body.append(container);
  let root: ReturnType<typeof createRoot> | undefined;
  const captured: CapturedViews = {};
  const capture = (id: ViewId, snapshot: ViewSnapshot) => {
    captured[id] = snapshot;
  };

  try {
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <>
          <CodeDocumentView id="narrow" handle={controller.handle} range={selectedRange} capture={capture} />
          <CodeDocumentView id="wide" handle={controller.handle} range={selectedRange} capture={capture} />
        </>,
      );
    });

    assert.equal(readView(container, "narrow").dataset.state, "open");
    assert.equal(readView(container, "narrow").dataset.lineCount, "2");
    assert.equal(readView(container, "narrow").dataset.info, "typescript");
    assert.equal(readView(container, "narrow").dataset.language, "typescript");
    assert.equal(readView(container, "wide").dataset.state, "open");
    assert.equal(readView(container, "wide").dataset.lineCount, "2");
    assert.equal(readLine(readView(container, "narrow"), 0).textContent, "const first = 1;");
    assert.equal(readLine(readView(container, "wide"), 0).textContent, "const first = 1;");
    assert.equal(readLine(readView(container, "narrow"), 0).dataset.exactness, "none");

    await act(async () => {
      const result = await controller.highlight({ mode: "range", range: selectedRange });
      assert.equal(result.exactness, "exact");
    });
    for (const id of ["narrow", "wide"] as const) {
      const firstLine = readLine(readView(container, id), 0);
      assert.equal(firstLine.dataset.exactness, "exact", `${id} view observes prepared exact decoration`);
      assert.equal(firstLine.textContent, "const first = 1;");
      assert.ok(firstLine.querySelector("[data-token]"), `${id} view renders the prepared token spans`);
    }

    const narrowBeforeAppend = captured.narrow!;
    const wideBeforeAppend = captured.wide!;
    const narrowRangeBeforeAppend = narrowBeforeAppend.lines;
    const wideRangeBeforeAppend = wideBeforeAppend.lines;
    const narrowRecordBeforeAppend = narrowBeforeAppend.lines[0]!;
    const wideRecordBeforeAppend = wideBeforeAppend.lines[0]!;

    await act(async () => {
      controller.append(appendedSource);
    });
    assert.strictEqual(captured.narrow!.lines, narrowRangeBeforeAppend, "unchanged selected range retains its public range identity");
    assert.strictEqual(captured.narrow!.lines[0], narrowRecordBeforeAppend, "unchanged selected record retains its public record identity");
    assert.strictEqual(captured.wide!.lines, wideRangeBeforeAppend, "the second view retains its unchanged public range identity");
    assert.strictEqual(captured.wide!.lines[0], wideRecordBeforeAppend, "the second view retains its unchanged public record identity");
    assert.equal(readView(container, "narrow").dataset.lineCount, "3");
    assert.equal(readView(container, "wide").dataset.lineCount, "3");
    assert.equal(readLine(readView(container, "narrow"), 0).textContent, "const first = 1;");
    assert.equal(controller.handle.readSource(), initialSource + appendedSource, "the handle preserves authored CRLF source exactly");

    await act(async () => {
      root!.render(
        <>
          <CodeDocumentView id="narrow" handle={controller.handle} range={selectedRange} capture={capture} />
          <CodeDocumentView id="wide" handle={controller.handle} range={expandedRange} capture={capture} />
        </>,
      );
    });
    assert.equal(captured.wide!.lines.length, 3);
    assert.equal(captured.wide!.lines[1]!.text, "const second = 2;");
    assert.equal(captured.wide!.lines[1]!.ending, "\r\n");
    assert.equal(readLine(readView(container, "wide"), 1).textContent, "const second = 2;");
    assert.equal(controller.handle.readSource(), initialSource + appendedSource, "expanded line records match the original CRLF-authored source");

    await act(async () => {
      const result = await controller.highlight({ mode: "range", range: expandedRange });
      assert.equal(result.exactness, "exact");
    });
    for (const id of ["narrow", "wide"] as const) {
      const firstLine = readLine(readView(container, id), 0);
      assert.equal(firstLine.dataset.exactness, "exact", `${id} view retains prepared decoration`);
      assert.ok(firstLine.querySelector("[data-token]"), `${id} view displays decorated source`);
    }
    const secondLine = readLine(readView(container, "wide"), 1);
    assert.equal(secondLine.dataset.exactness, "exact");
    assert.equal(secondLine.textContent, "const second = 2;");

    await act(async () => {
      root!.render(
        <CodeDocumentView id="wide" handle={controller.handle} range={expandedRange} capture={capture} />,
      );
    });
    assert.equal(container.querySelector('[data-code-view="narrow"]'), null, "the narrow consumer is unmounted");

    await act(async () => {
      controller.append(tailAppend);
    });
    const authoredSource = initialSource + appendedSource + tailAppend;
    assert.equal(controller.handle.readSource(), authoredSource);
    assert.equal(readLine(readView(container, "wide"), 2).textContent, "const third = 3; // continued");
    assert.equal(readLine(readView(container, "wide"), 2).dataset.exactness, "none");

    await act(async () => {
      const result = await controller.highlight({ mode: "range", range: expandedRange });
      assert.equal(result.exactness, "exact");
    });
    const advancedLine = readLine(readView(container, "wide"), 2);
    assert.equal(advancedLine.textContent, "const third = 3; // continued");
    assert.equal(advancedLine.dataset.exactness, "exact");
    assert.ok(advancedLine.querySelector("[data-token]"));

    await act(async () => {
      controller.finalize();
    });
    assert.equal(readView(container, "wide").dataset.state, "finalized");
    assert.equal(readView(container, "wide").dataset.lineCount, "3");
    assert.equal(controller.handle.readSource(), authoredSource, "finalization changes metadata without appending authored bytes");
  } finally {
    try {
      if (root) await act(async () => root!.unmount());
    } finally {
      try {
        controller.dispose();
      } finally {
        container.remove();
        for (const [key, descriptor] of previousGlobals) {
          if (descriptor) Object.defineProperty(globalThis, key, descriptor);
          else Reflect.deleteProperty(globalThis, key);
        }
        dom.window.close();
      }
    }
  }
}

await runCodeHandleHooksTest();
console.log("code handle hook tests passed");
