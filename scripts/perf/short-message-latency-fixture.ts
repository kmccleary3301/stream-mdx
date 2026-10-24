import React from "react";
import { createRoot } from "react-dom/client";
import { StreamingMarkdown, type StreamingMarkdownHandle } from "@stream-mdx/react";

type Engine = "auto" | "worker";
type BenchmarkResult = {
  firstContentMs: number;
  inlineDecorationReadyMs: number;
  firstText: string;
  workerStartupMs: number | null;
};

declare global {
  interface Window {
    __SHORT_MESSAGE_RESULT__?: Promise<BenchmarkResult>;
  }
}

const params = new URLSearchParams(window.location.search);
const engine = params.get("engine");
const message = params.get("message");
if (engine !== "auto" && engine !== "worker") throw new Error(`Unsupported benchmark engine: ${engine}`);
if (!message) throw new Error("Missing short-message benchmark input");

const container = document.getElementById("root");
if (!container) throw new Error("Missing benchmark root");
let currentHandle: StreamingMarkdownHandle | null = null;
let appendStartedAt = 0;
let appendIssued = false;
let startupRaf = 0;
let resolveResult: (result: BenchmarkResult) => void = () => {};
let rejectResult: (error: Error) => void = () => {};
let resolveWorkerStartup: (elapsedMs: number) => void = () => {};
let workerStartupMs: number | null = null;
let workerStartup: Promise<number> | null = null;
const mountedAt = performance.now();

window.__SHORT_MESSAGE_RESULT__ = new Promise<BenchmarkResult>((resolve, reject) => {
  resolveResult = resolve;
  rejectResult = reject;
});

let firstText: string | null = null;
let firstContentMs: number | null = null;
let inlineDecorationReadyMs: number | null = null;
const observer = new MutationObserver(() => {
  if (!appendIssued) return;
  if (firstText === null) {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const text = node.nodeValue ?? "";
      if (text.trim().length > 0 && message.includes(text)) {
        firstText = text;
        firstContentMs = performance.now() - appendStartedAt;
        break;
      }
    }
  }
  if (
    inlineDecorationReadyMs === null &&
    container.querySelector("h1") &&
    container.querySelectorAll("p").length === 2 &&
    container.querySelectorAll("code").length === 3 &&
    container.querySelectorAll("li").length === 3
  ) {
    inlineDecorationReadyMs = performance.now() - appendStartedAt;
  }
  if (firstText === null || firstContentMs === null || inlineDecorationReadyMs === null) return;
  const authoredText = firstText;
  const measuredFirstContentMs = firstContentMs;
  const measuredDecorationReadyMs = inlineDecorationReadyMs;
  observer.disconnect();
  void (async () => {
    if (workerStartup) workerStartupMs = await workerStartup;
    resolveResult({
      firstContentMs: measuredFirstContentMs,
      inlineDecorationReadyMs: measuredDecorationReadyMs,
      firstText: authoredText,
      workerStartupMs,
    });
  })().catch((error: unknown) => rejectResult(error instanceof Error ? error : new Error(String(error))));
});
observer.observe(container, { childList: true, characterData: true, subtree: true });

const observeWorkerStartup = () => {
  if (currentHandle?.getState().workerReady) {
    workerStartupMs = performance.now() - mountedAt;
    resolveWorkerStartup(workerStartupMs);
    return;
  }
  startupRaf = requestAnimationFrame(observeWorkerStartup);
};

const onHandleMount = (handle: StreamingMarkdownHandle | null) => {
  if (!handle || appendIssued) return;
  currentHandle = handle;
  appendIssued = true;
  if (engine === "worker") {
    workerStartup = new Promise<number>((resolve) => {
      resolveWorkerStartup = resolve;
    });
    observeWorkerStartup();
  }
  appendStartedAt = performance.now();
  try {
    handle.append(message);
  } catch (error) {
    observer.disconnect();
    rejectResult(error instanceof Error ? error : new Error(String(error)));
  }
};

createRoot(container).render(
  React.createElement(StreamingMarkdown, {
    ref: onHandleMount,
    engine: engine as Engine,
    worker: engine === "worker" ? "/workers/markdown-worker.js" : undefined,
    features: { tables: false, html: false, mdx: false, math: false },
    caret: false,
    onError: (error: Error) => rejectResult(error),
  }),
);

window.addEventListener("pagehide", () => {
  observer.disconnect();
  if (startupRaf) cancelAnimationFrame(startupRaf);
});
