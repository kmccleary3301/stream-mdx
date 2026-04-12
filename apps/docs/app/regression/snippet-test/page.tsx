"use client";

import { StreamingMarkdownDemoV2 } from "@/components/screens/streaming-markdown-demo-v2";
import React from "react";

declare global {
  type SnippetTestConfig = {
    initialStreamLimit?: number | null;
    initialIsRunning?: boolean;
    initialMdxStrategy?: "server" | "worker";
  };

  interface Window {
    __TEST_SNIPPET_CONTENT__?: string;
    __TEST_SNIPPET_CONFIG__?: SnippetTestConfig;
  }
}

export default function Page() {
  return (
    <div className="container mx-auto max-w-4xl py-8">
      <h1 className="mb-2 text-2xl font-bold">Snippet Test</h1>
      <SnippetTestClient />
    </div>
  );
}

function SnippetTestClient() {
  const [content, setContent] = React.useState<string>("");
  const [config, setConfig] = React.useState<SnippetTestConfig>({});

  React.useEffect(() => {
    if (typeof window === "undefined") return;

    const params = new URLSearchParams(window.location.search);
    const snippet = params.get("snippet");
    if (snippet) {
      try {
        let decoded = decodeURIComponent(snippet);
        try {
          const binary = atob(decoded);
          const bytes = new Uint8Array(binary.length);
          for (let idx = 0; idx < binary.length; idx += 1) {
            bytes[idx] = binary.charCodeAt(idx);
          }
          decoded = typeof TextDecoder !== "undefined" ? new TextDecoder("utf-8").decode(bytes) : decodeURIComponent(escape(binary));
        } catch {
          // already plain text
        }
        if (decoded.length > 0) {
          setContent(decoded);
          return;
        }
      } catch {
        // ignore
      }
    }

    const stored = window.__TEST_SNIPPET_CONTENT__;
    const storedConfig = window.__TEST_SNIPPET_CONFIG__;
    if (storedConfig && typeof storedConfig === "object") {
      setConfig(storedConfig);
    }
    if (stored && typeof stored === "string") {
      setContent(stored);
    }
  }, []);

  if (!content) {
    return (
      <div className="text-muted">
        Waiting for snippet content... (set via window.__TEST_SNIPPET_CONTENT__ or ?snippet= param)
      </div>
    );
  }

  return (
    <StreamingMarkdownDemoV2
      fullText={content}
      initialStreamLimit={config.initialStreamLimit ?? null}
      initialIsRunning={typeof config.initialIsRunning === "boolean" ? config.initialIsRunning : true}
      initialMdxStrategy={config.initialMdxStrategy ?? "worker"}
    />
  );
}
