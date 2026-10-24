import type { Block, WorkerOut } from "@stream-mdx/core";
import React from "react";
import { createRoot, hydrateRoot, type Root } from "react-dom/client";
import { StreamingMarkdown, type StreamingMarkdownHandle } from "@stream-mdx/react";
import { MarkdownBlocksRenderer } from "@stream-mdx/react/server";
import mermaid from "mermaid";
import type { MermaidModule } from "@stream-mdx/mermaid";
import { createMermaidSmokeRenderers, WARM_MARKDOWN } from "./p8-mermaid-smoke-components";

type MermaidSmokeHook = {
  bindCount: number;
  disposeCount: number;
  activeBindings: number;
  bindSources: string[];
  disposedSources: string[];
  hydrationErrors: string[];
  workerMessages: string[];
  hydrated: boolean;
  startStream?: () => Promise<void>;
  startCleanup?: () => void;
  replaceCleanupSource?: () => void;
  unmountCleanup?: () => void;
};

declare global {
  interface Window {
    __P8_MERMAID_SMOKE__?: MermaidSmokeHook;
  }
}

const hook: MermaidSmokeHook = {
  bindCount: 0,
  disposeCount: 0,
  activeBindings: 0,
  bindSources: [],
  disposedSources: [],
  hydrationErrors: [],
  workerMessages: [],
  hydrated: false,
};
window.__P8_MERMAID_SMOKE__ = hook;

const actualMermaid = mermaid as unknown as MermaidModule;
const trackedMermaid: MermaidModule = {
  initialize(config) {
    actualMermaid.initialize?.(config);
  },
  async render(id, code) {
    if (typeof actualMermaid.render !== "function") {
      throw new Error("the real Mermaid module does not expose render()");
    }
    const result = await actualMermaid.render(id, code);
    const svg = typeof result === "string" ? result : result.svg;
    const bind = typeof result === "string" ? undefined : result.bindFunctions;
    return {
      svg,
      bindFunctions(element) {
        const actualDisposer = bind?.(element);
        hook.bindCount += 1;
        hook.activeBindings += 1;
        hook.bindSources.push(code);
        let disposed = false;
        return () => {
          if (disposed) return;
          disposed = true;
          actualDisposer?.();
          hook.disposeCount += 1;
          hook.activeBindings -= 1;
          hook.disposedSources.push(code);
        };
      },
    };
  },
};

const configured = createMermaidSmokeRenderers(trackedMermaid);
const workerMessages: string[] = hook.workerMessages;
const NativeWorker = window.Worker;
window.Worker = class extends NativeWorker {
  constructor(scriptURL: string | URL, options?: WorkerOptions) {
    super(scriptURL, options);
    this.addEventListener("message", (event: MessageEvent<WorkerOut>) => {
      workerMessages.push(event.data.type);
    });
  }
};

const hydrationRoot = document.getElementById("hydration-root");
const ssrBlocksScript = document.getElementById("p8-ssr-blocks");
if (!hydrationRoot || !ssrBlocksScript) throw new Error("missing server-rendered Mermaid fixture");
const ssrBlocks = JSON.parse(ssrBlocksScript.textContent ?? "null") as Block[];
hydrateRoot(
  hydrationRoot,
  React.createElement(MarkdownBlocksRenderer, {
    blocks: ssrBlocks,
    engines: configured.engines,
  }),
  { onRecoverableError: (error) => hook.hydrationErrors.push(String(error)) },
);
hook.hydrated = true;

const streamingHandle = React.createRef<StreamingMarkdownHandle>();
const streamRootElement = document.getElementById("stream-root");
const cleanupRootElement = document.getElementById("cleanup-root");
if (!streamRootElement || !cleanupRootElement) throw new Error("missing Mermaid fixture roots");
const streamRoot = createRoot(streamRootElement);
streamRoot.render(
  React.createElement(StreamingMarkdown, {
    ref: streamingHandle,
    engine: "worker",
    worker: "/workers/markdown-worker.js",
    engines: configured.engines,
    features: { html: false, mdx: false, tables: false, math: false },
    caret: false,
  }),
);

async function waitForRenderer(): Promise<StreamingMarkdownHandle> {
  const deadline = Date.now() + 15_000;
  while (true) {
    const renderer = streamingHandle.current;
    if (renderer?.getState().workerReady) return renderer;
    if (Date.now() >= deadline) throw new Error("the Mermaid smoke Worker did not attach");
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
}

async function appendAndDrain(renderer: StreamingMarkdownHandle, source: string): Promise<void> {
  const result = renderer.append(source);
  if (result.shouldPause) await renderer.waitForCapacity({ units: 0 });
  await renderer.waitForIdle();
}

hook.startStream = async () => {
  const renderer = await waitForRenderer();
  await appendAndDrain(renderer, WARM_MARKDOWN);
  await renderer.finalize();
  await renderer.waitForIdle();
};

let cleanupRoot: Root | null = null;
const initialCleanupSource = [
  "flowchart TD",
  '  CleanupStart["Cleanup initial"] --> CleanupEnd["Cleanup target"]',
].join("\n");
const replacementCleanupSource = [
  "flowchart TD",
  '  ReplacedStart["Replaced node"] --> ReplacedEnd["Replacement target"]',
].join("\n");

function renderCleanupSource(code: string): void {
  cleanupRoot ??= createRoot(cleanupRootElement);
  cleanupRoot.render(
    React.createElement(configured.warm, {
      blockId: "p8-cleanup-block",
      code,
      language: "mermaid",
      renderCode: React.createElement("pre", null, code),
    }),
  );
}

hook.startCleanup = () => renderCleanupSource(initialCleanupSource);
hook.replaceCleanupSource = () => renderCleanupSource(replacementCleanupSource);
hook.unmountCleanup = () => {
  cleanupRoot?.unmount();
  cleanupRoot = null;
};
