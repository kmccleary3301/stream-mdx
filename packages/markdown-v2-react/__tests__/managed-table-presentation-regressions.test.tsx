import assert from "node:assert/strict";
import { StreamingMarkdown, type NodePresentations, type NodeViewActions, type StreamingMarkdownHandle } from "@stream-mdx/react";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { installTrustedNativeTestDom, waitFor, workerFactory } from "./trusted-native-fixture";

const HEADER = "| ID | Description |\n| --- | --- |\n";
const tableRows = (from: number, to: number, label = "Row"): string => Array.from(
  { length: to - from },
  (_, offset) => `| ${label}-${from + offset} | Description-${from + offset} |`,
).join("\n") + "\n";

async function filteredManagedTablesRenderNoShellOrControls(): Promise<void> {
  const restore = installTrustedNativeTestDom();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const stream = React.createRef<StreamingMarkdownHandle>();
  let wrapperCalls = 0;
  try {
    await act(async () => {
      root.render(
        <StreamingMarkdown
          ref={stream}
          worker={() => workerFactory()}
          contentPolicy="markdown"
          features={{ tables: true }}
          controls={{ table: true }}
          disallowedElements={["table"]}
          caret={false}
          components={{
            table: {
              wrapper: ({ children }) => {
                wrapperCalls += 1;
                return <>{children}</>;
              },
            },
          }}
        />,
      );
    });
    await waitFor(() => stream.current?.getState().workerReady === true, "filtered table worker is ready");
    await act(async () => {
      stream.current?.append(HEADER + tableRows(0, 2));
      await stream.current?.finalize();
    });
    await waitFor(() => stream.current?.getState().blocks.some((block) => block.type === "table") === true,
      "the public stream owns the filtered table block");

    assert.equal(wrapperCalls, 0, "a filtered managed table does not invoke its presentation wrapper");
    assert.equal(container.querySelector("table"), null, "a disallowed managed table has no native table");
    assert.equal(container.querySelector(".stream-mdx-table-wrapper"), null, "a filtered managed table emits no control shell");
    assert.equal(container.querySelector('[aria-label="Scrollable table"]'), null, "a filtered managed table emits no viewport shell");
    assert.equal(container.querySelector("button[data-stream-mdx-action]"), null, "a filtered managed table emits no controls");
  } finally {
    root.unmount();
    restore();
  }
}
try {
  await filteredManagedTablesRenderNoShellOrControls();
  console.log("filtered managed table regression passed");
} catch (error) {
  console.error(error);
  process.exit(1);
}

process.exit(0);
