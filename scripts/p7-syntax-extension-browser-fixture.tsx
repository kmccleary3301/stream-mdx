import type { WorkerOut } from "@stream-mdx/core";
import React from "react";
import { createRoot } from "react-dom/client";
import { StreamingMarkdown, type StreamingMarkdownHandle } from "@stream-mdx/react";

import {
  STREAMING_SYNTAX_DEMO,
  STREAMING_SYNTAX_DEMO_CONTENT_COMPONENTS,
  STREAMING_SYNTAX_DEMO_INLINE_COMPONENTS,
  STREAMING_SYNTAX_DEMO_MARKDOWN,
} from "../apps/docs/lib/streaming-syntax-demo";

const handle = React.createRef<StreamingMarkdownHandle>();
const workerMessages: string[] = [];
const NativeWorker = window.Worker;
window.Worker = class extends NativeWorker {
  constructor(scriptURL: string | URL, options?: WorkerOptions) {
    super(scriptURL, options);
    this.addEventListener("message", (event: MessageEvent<WorkerOut>) => {
      workerMessages.push(event.data.type);
    });
  }
};

async function waitForRenderer(): Promise<StreamingMarkdownHandle> {
  const deadline = Date.now() + 15_000;
  while (true) {
    const renderer = handle.current;
    if (renderer?.getState().workerReady) return renderer;
    if (Date.now() >= deadline) throw new Error("the StreamingMarkdown worker did not attach");
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
}

function createChunks(source: string): string[] {
  const highlightPartialEnd = source.indexOf("==highlight==") + "==hi".length;
  const containerPartialEnd = source.indexOf(":::note") + ":::no".length;
  if (highlightPartialEnd <= 0 || containerPartialEnd <= highlightPartialEnd) {
    throw new Error("the syntax demo fixture is missing its streaming boundary markers");
  }
  return [
    source.slice(0, highlightPartialEnd),
    source.slice(highlightPartialEnd, containerPartialEnd),
    source.slice(containerPartialEnd),
  ];
}

export async function startSyntaxExtensionStream(): Promise<void> {
  const renderer = await waitForRenderer();
  for (const chunk of createChunks(STREAMING_SYNTAX_DEMO_MARKDOWN)) {
    const result = renderer.append(chunk);
    if (result.shouldPause) await renderer.waitForCapacity({ units: 0 });
    await renderer.waitForIdle();
  }
  await renderer.finalize();
}

declare global {
  interface Window {
    __P7_SYNTAX_SMOKE__?: {
      start: () => Promise<void>;
      workerMessages: string[];
    };
  }
}

window.__P7_SYNTAX_SMOKE__ = { start: startSyntaxExtensionStream, workerMessages };

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("missing public React root");

createRoot(rootElement).render(
  <StreamingMarkdown
    ref={handle}
    engine="worker"
    syntax={STREAMING_SYNTAX_DEMO}
    contentPolicy="restricted"
    contentComponents={STREAMING_SYNTAX_DEMO_CONTENT_COMPONENTS}
    inlineComponents={STREAMING_SYNTAX_DEMO_INLINE_COMPONENTS}
    features={{ mdx: true, html: false, tables: false, math: false, formatAnticipation: { inline: true, regex: true } }}
    caret={false}
  />,
);
