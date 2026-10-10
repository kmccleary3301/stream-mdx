"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CodeFenceRenderer,
  MarkdownEngineMode,
  StreamingMarkdownHandle,
  StreamingMarkdownProps,
} from "@stream-mdx/react";
import { ArtifactFrame, StreamingMarkdown } from "@stream-mdx/react";
import { MermaidBlock } from "@stream-mdx/mermaid";
import "katex/dist/katex.min.css";

import { BottomStickScrollArea } from "@/components/layout/bottom-stick-scroll-area";
import { Button } from "@/components/ui/button";
import { DocsCodeBlock } from "@/components/markdown/docs-code-block";
import { cn } from "@/lib/utils";
import { AlertCircle, Cpu, Pause, Play, RotateCcw, ShieldCheck, Terminal } from "lucide-react";

const USER_PROMPT =
  "Can you provide an architectural walkthrough of the StreamMDX engine-v2 pipeline? Include Bayes' Theorem with concrete mathematical notation, the engine flow diagram, a custom code fence renderer example, and an interactive self-contained HTML visualization artifact.";

/**
 * Custom code fence renderer example for language "metric".
 * Replaces standard code block with a structured metrics grid when valid JSON is provided.
 */
const CustomMetricRenderer: CodeFenceRenderer = ({ code, language, isFinalized, renderCode }) => {
  try {
    const data = JSON.parse(code.trim());
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      return <>{renderCode}</>;
    }
    return (
      <div className="my-4 rounded-xl border border-border/80 bg-muted/20 p-4 shadow-sm not-prose">
        <div className="flex items-center justify-between border-b border-border/60 pb-2 mb-3">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-emerald-500" />
            <span className="text-xs font-semibold text-foreground uppercase tracking-wider">
              Custom Code Fence Renderer ({language})
            </span>
          </div>
          <span className="rounded-md border border-border/60 bg-background/80 px-2 py-0.5 text-[11px] font-mono text-muted-foreground">
            {isFinalized ? "Finalized AST" : "Streaming..."}
          </span>
        </div>
        <div className="text-[10px] text-muted-foreground italic mb-2">Example data, not a benchmark</div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {Object.entries(data).map(([key, val]) => (
            <div key={key} className="rounded-lg border border-border/50 bg-background/60 p-3">
              <div className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">{key}</div>
              <div className="mt-1 font-mono text-base font-semibold text-foreground">{String(val)}</div>
            </div>
          ))}
        </div>
      </div>
    );
  } catch {
    return <>{renderCode}</>;
  }
};

const STREAMING_INTERVAL_MS = 25;
const CHUNK_SIZE_CHARS = 45;

interface AssistantStreamClientProps {
  fullContent: string;
}

export function AssistantStreamClient({ fullContent }: AssistantStreamClientProps) {
  const handleRef = useRef<StreamingMarkdownHandle | null>(null);
  const streamIndexRef = useRef(0);
  const isPausedRef = useRef(false);
  const generationRef = useRef(0);

  const [engineMode, setEngineMode] = useState<MarkdownEngineMode>("worker");
  const [sessionKey, setSessionKey] = useState(0);
  const [streamIndex, setStreamIndex] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const [status, setStatus] = useState<"initializing" | "streaming" | "paused" | "complete" | "error">(
    "initializing",
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const totalLength = fullContent.length;

  useEffect(() => {
    generationRef.current += 1;
    const currentGeneration = generationRef.current;

    setErrorMessage(null);
    setStatus("initializing");
    setStreamIndex(0);
    streamIndexRef.current = 0;

    let cancelled = false;

    const runStream = async () => {
      const startWait = Date.now();
      const timeoutMs = 15000;

      // Wait until the handle is mounted and the engine/worker is ready
      while (!cancelled && currentGeneration === generationRef.current) {
        const handle = handleRef.current;
        if (handle) {
          try {
            if (handle.getState().workerReady) {
              break;
            }
          } catch {
            // Worker is still instantiating
          }
        }

        if (Date.now() - startWait > timeoutMs) {
          if (!cancelled && currentGeneration === generationRef.current) {
            setErrorMessage(`Failed to initialize ${engineMode} engine within timeout.`);
            setStatus("error");
          }
          return;
        }

        await new Promise((resolve) => setTimeout(resolve, 30));
      }

      if (cancelled || currentGeneration !== generationRef.current) return;

      const handle = handleRef.current;
      if (!handle) {
        setErrorMessage("Markdown renderer handle unavailable.");
        setStatus("error");
        return;
      }

      setStatus(isPausedRef.current ? "paused" : "streaming");

      // Incrementally stream chunks
      while (!cancelled && currentGeneration === generationRef.current) {
        if (isPausedRef.current) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          continue;
        }

        const currentIndex = streamIndexRef.current;
        if (currentIndex >= fullContent.length) {
          handle.finalize();
          setStatus("complete");
          break;
        }

        const nextIndex = Math.min(fullContent.length, currentIndex + CHUNK_SIZE_CHARS);
        const chunk = fullContent.slice(currentIndex, nextIndex);
        handle.append(chunk);

        streamIndexRef.current = nextIndex;
        setStreamIndex(nextIndex);

        if (nextIndex >= fullContent.length) {
          handle.finalize();
          setStatus("complete");
          break;
        }

        await new Promise((resolve) => setTimeout(resolve, STREAMING_INTERVAL_MS));
      }
    };

    void runStream();

    return () => {
      cancelled = true;
    };
  }, [fullContent, engineMode, sessionKey]);

  const handleRestart = useCallback(() => {
    isPausedRef.current = false;
    setIsPaused(false);
    setSessionKey((prev) => prev + 1);
  }, []);

  const handleEngineChange = useCallback((mode: MarkdownEngineMode) => {
    setEngineMode(mode);
    isPausedRef.current = false;
    setIsPaused(false);
    setSessionKey((prev) => prev + 1);
  }, []);

  const handleTogglePause = useCallback(() => {
    setIsPaused((prev) => {
      const next = !prev;
      isPausedRef.current = next;
      setStatus((currentStatus) => {
        if (currentStatus === "streaming" && next) return "paused";
        if (currentStatus === "paused" && !next) return "streaming";
        return currentStatus;
      });
      return next;
    });
  }, []);

  const components = useMemo(
    () => ({
      code: DocsCodeBlock,
    }),
    [],
  );

  const codeRenderers = useMemo(
    () => ({
      mermaid: MermaidBlock,
      "html-artifact": ArtifactFrame,
      artifact: ArtifactFrame,
      metric: CustomMetricRenderer,
    }),
    [],
  );

  const features = useMemo<NonNullable<StreamingMarkdownProps["features"]>>(
    () => ({
      mdx: false, // SAFE DEFAULT: mdx=false for agent content
      html: false, // Enforce artifact containment rather than raw HTML injection
      tables: true,
      math: true,
      callouts: true,
      codeHighlighting: "final",
    }),
    [],
  );

  const linkSafety = useMemo(
    () => ({
      enabled: true,
    }),
    [],
  );

  const isStreamingActive = status === "streaming" || status === "initializing";

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-8">
      {/* Route Header */}
      <header className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <span className="rounded-full border border-primary/30 bg-primary/10 px-2.5 py-0.5 text-xs font-semibold text-primary">
            Executable Showcase
          </span>
          <span className="text-xs text-muted-foreground">apps/docs/app/showcase/assistant-stream</span>
        </div>
        <h1 className="text-3xl font-semibold tracking-tight text-foreground md:text-4xl">
          Streaming Assistant & Sandboxed Artifacts
        </h1>
        <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground md:text-base">
          Chat-thread example demonstrating dual-engine streaming (worker vs. main-thread), formatted math, Mermaid
          diagrams, custom code fence renderers, link safety, and sandboxed HTML visualizations via{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">ArtifactFrame</code>.
        </p>
      </header>

      {/* Control Surface */}
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border/80 bg-card p-4 shadow-sm">
        {/* Engine Selector */}
        <div className="flex items-center gap-3">
          <span className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
            <Cpu className="h-4 w-4" />
            Engine Mode:
          </span>
          <div className="inline-flex rounded-lg border border-border/70 bg-muted/40 p-1">
            <button
              type="button"
              onClick={() => handleEngineChange("worker")}
              className={cn(
                "rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                engineMode === "worker"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              Worker (Dedicated Thread)
            </button>
            <button
              type="button"
              onClick={() => handleEngineChange("main-thread")}
              className={cn(
                "rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                engineMode === "main-thread"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              Main Thread (Inline Engine)
            </button>
          </div>
        </div>

        {/* Streaming Controls & Status */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 text-xs">
            <span
              className={cn(
                "inline-flex h-2 w-2 rounded-full",
                status === "streaming" && "bg-amber-500",
                status === "initializing" && "bg-blue-500",
                status === "paused" && "bg-yellow-500",
                status === "complete" && "bg-emerald-500",
                status === "error" && "bg-destructive",
              )}
            />
            <span className="font-mono text-muted-foreground">
              {status === "initializing" && "Initializing engine..."}
              {status === "streaming" && `Streaming... (${streamIndex}/${totalLength} chars)`}
              {status === "paused" && `Paused (${streamIndex}/${totalLength} chars)`}
              {status === "complete" && `Complete (${totalLength}/${totalLength} chars)`}
              {status === "error" && "Engine error"}
            </span>
          </div>

          <Button
            size="sm"
            variant="outline"
            onClick={handleTogglePause}
            disabled={status === "complete" || status === "error" || status === "initializing"}
          >
            {isPaused ? <Play className="mr-1.5 h-3.5 w-3.5" /> : <Pause className="mr-1.5 h-3.5 w-3.5" />}
            {isPaused ? "Resume" : "Pause"}
          </Button>

          <Button size="sm" variant="default" onClick={handleRestart}>
            <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
            Restart Stream
          </Button>
        </div>
      </div>

      {/* Security & Sandbox Status Banner */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/60 bg-muted/30 px-4 py-2.5 text-xs text-muted-foreground">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-emerald-500" />
          <span>
            <strong className="text-foreground font-semibold">Safe Defaults Enforced:</strong>{" "}
            <code>features.mdx = false</code>, strict CSP (<code>connect-src 'none'</code>), isolated iframe sandbox.
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <Terminal className="h-3.5 w-3.5" />
          <span>Click any hyperlink to verify link safety modal interception.</span>
        </div>
      </div>

      {/* Chat Thread Surface */}
      <div className="flex flex-col gap-6 rounded-2xl border border-border bg-background p-6 shadow-sm">
        {/* User Message */}
        <div className="flex gap-4 border-b border-border/60 pb-6">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">
            U
          </div>
          <div className="flex flex-col gap-1.5 pt-0.5">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-foreground">User</span>
              <span className="text-xs text-muted-foreground">Prompt</span>
            </div>
            <p className="text-sm text-foreground/90 leading-relaxed">{USER_PROMPT}</p>
          </div>
        </div>

        {/* Assistant Message (Streaming) */}
        <div className="flex gap-4">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-500/10 text-xs font-bold text-emerald-600 dark:text-emerald-400">
            AI
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-2 pt-0.5">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-foreground">StreamMDX Assistant</span>
              <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground uppercase">
                {engineMode}
              </span>
              {isStreamingActive && (
                <span className="text-[11px] text-amber-500 font-medium">
                  {status === "initializing" ? "initializing..." : "streaming tokens..."}
                </span>
              )}
            </div>

            {/* Error Callout if Worker or Engine Fails */}
            {errorMessage && (
              <div className="my-2 flex items-start gap-2.5 rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-xs text-destructive">
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                <div>
                  <div className="font-semibold">Renderer Error</div>
                  <div className="mt-0.5">{errorMessage}</div>
                </div>
              </div>
            )}

            <BottomStickScrollArea
              className="w-full max-h-[720px] rounded-xl border border-border/50 bg-background/50 p-4"
              contentClassName="prose prose-neutral dark:prose-invert max-w-none text-theme-primary text-sm leading-relaxed"
            >
              <StreamingMarkdown
                key={`session-${sessionKey}-${engineMode}`}
                ref={handleRef}
                engine={engineMode}
                worker={engineMode === "worker" ? "/workers/markdown-worker.js" : undefined}
                className="markdown-v2-output"
                components={components}
                codeRenderers={codeRenderers}
                features={features}
                linkSafety={linkSafety}
                onError={(error) => {
                  setErrorMessage(error.message);
                  setStatus("error");
                }}
              />
            </BottomStickScrollArea>
          </div>
        </div>
      </div>
    </div>
  );
}
