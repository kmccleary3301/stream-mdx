import type { ReactNode } from "react";

import { Link } from "next-view-transitions";

import { DocsShell } from "@/components/docs/docs-shell";
import { StreamingCodeBlock } from "@/components/markdown/streaming-code-block";
import { Button } from "@/components/ui/button";
import { DOC_SECTIONS } from "@/lib/docs";

import {
  ArrowRight,
  Blocks,
  GitCommitHorizontal,
  Layers,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
} from "lucide-react";

function docHref(slug: string) {
  if (!slug) return "/docs";
  return `/docs/${slug}`;
}

const navSections = DOC_SECTIONS.map((section) => ({
  title: section.title,
  items: section.items.map((item) => ({
    title: item.title,
    href: docHref(item.slug),
  })),
}));

const protocolSchema = `{
  "protocol": "streammdx",
  "schemaVersion": "1.0",
  "streamId": "a9f2c0c1-7c9c-4b2b-8c29-f2df20c30f6a",
  "event": "patch",
  "tx": 42,
  "patches": [
    {
      "op": "appendLines",
      "at": ["__root__", 3],
      "startIndex": 0,
      "lines": ["# Title", "Streaming docs"],
      "tokens": [{"spans": [{"t": "# Title", "s": {"fg": "#93c5fd"}}]}]
    }
  ]
}`;

const tokenSnippet = `{
  "type": "code-line",
  "index": 12,
  "text": "const stream = createStream();",
  "tokens": {
    "spans": [
      { "t": "const", "s": { "fg": "#60a5fa", "fs": 1 } },
      { "t": " stream = ", "s": { "fg": "#e2e8f0" } },
      { "t": "createStream", "s": { "fg": "#f97316" } },
      { "t": "()", "s": { "fg": "#e2e8f0" } }
    ]
  }
}`;

const diffSnippet = `@@ -12,7 +12,8 @@
-export function render() {
+export function render() {
+  const { patches } = stream;
   return <Renderer patches={patches} />;
 }
`;

function CodePanel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-border/60 bg-background p-4 shadow-sm">
      <div className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-old">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-muted-old" />
          {title}
        </div>
        <span className="text-[10px] text-muted-foreground">streammdx</span>
      </div>
      <div className="mt-3">{children}</div>
    </div>
  );
}

export default function TuiJsonProtocolPage() {
  const lifecycle = [
    {
      title: "init",
      description: "Announce schema + theme metadata.",
      icon: Sparkles,
    },
    {
      title: "block_snapshot",
      description: "Emit stable block snapshots.",
      icon: Blocks,
    },
    {
      title: "patch_batch",
      description: "Append lines with tokens + diffs.",
      icon: GitCommitHorizontal,
    },
    {
      title: "finalize",
      description: "Seal the stream + final tx.",
      icon: Layers,
    },
  ];

  return (
    <div className="relative -mx-6 rounded-3xl border border-border/60 bg-muted/20 p-6 shadow-sm md:p-10">
      <DocsShell
        sections={navSections}
        showToc={false}
        navClassName="lg:pr-4"
        tocClassName="lg:pl-4"
      >
        <div id="article-content-wrapper" className="flex flex-col gap-12 text-foreground">
          <header className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-3 text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-old">
              <span className="rounded-full border border-border/60 bg-background/60 px-3 py-1">Streaming v2</span>
              <span className="rounded-full border border-border/60 bg-background/60 px-3 py-1">Protocol</span>
            </div>
            <div>
              <h1 id="tui-json-stream-protocol" className="text-3xl font-semibold tracking-tight md:text-4xl">
                TUI / JSON Stream Protocol
              </h1>
              <p className="mt-3 max-w-2xl text-sm text-muted-foreground md:text-base">
                A production-ready JSON stream spec for terminal renderers, diff-aware patching, and
                token-level highlighting. Designed to stay deterministic while supporting high-frequency
                streaming output.
              </p>
            </div>
          </header>

          <section className="grid gap-6 lg:grid-cols-[1.1fr_1fr]">
            <div className="rounded-2xl border border-border/60 bg-background p-5 shadow-sm">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-muted-old">
                <TerminalSquare size={14} /> Structured documentation
              </div>
              <div className="mt-4 space-y-3 text-sm text-muted-foreground">
                <p>
                  Convert streaming markdown into stable JSON blocks with inline token streams, diff metadata,
                  and predictable patch application.
                </p>
                <ul className="space-y-2 text-xs">
                  <li className="flex items-start gap-2">
                    <span className="mt-1 h-1.5 w-1.5 rounded-full bg-muted-old" />
                    Block snapshots for stable layout in terminal UIs.
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="mt-1 h-1.5 w-1.5 rounded-full bg-muted-old" />
                    Token spans that map directly to ANSI palettes.
                  </li>
                  <li className="flex items-start gap-2">
                    <span className="mt-1 h-1.5 w-1.5 rounded-full bg-muted-old" />
                    Patch diffs for incremental highlight updates.
                  </li>
                </ul>
              </div>
            </div>
            <CodePanel title="Event envelope">
              <StreamingCodeBlock className="code-panel-block" code={protocolSchema} language="json" />
            </CodePanel>
          </section>

          <section>
            <h2 id="lifecycle" className="text-xl font-semibold">
              The lifecycle of a stream
            </h2>
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
              StreamMDX emits a predictable sequence of events that keep terminal UIs stable while incremental
              updates arrive.
            </p>
            <div className="mt-6 relative grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div className="pointer-events-none absolute left-6 right-6 top-8 hidden h-px bg-border/60 lg:block" />
              {lifecycle.map((step) => {
                const Icon = step.icon;
                return (
                  <div key={step.title} className="rounded-xl border border-border/60 bg-background p-4 shadow-sm">
                    <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-muted-old">
                      <span className="flex h-7 w-7 items-center justify-center rounded-md border border-border/60 bg-background/60">
                        <Icon size={14} />
                      </span>
                      {step.title}
                    </div>
                    <p className="mt-3 text-xs text-muted-foreground">{step.description}</p>
                  </div>
                );
              })}
            </div>
          </section>

          <section>
            <h2 id="protocol-schema" className="text-xl font-semibold">
              Protocol schema
            </h2>
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
              Events are typed, versioned, and replayable. Consumers ignore unknown fields to keep the stream
              forward-compatible.
            </p>
            <CodePanel title="Protocol schema">
              <StreamingCodeBlock
                className="code-panel-block"
                code={`{\n  \"protocol\": \"streammdx\",\n  \"schemaVersion\": \"1.0\",\n  \"event\": \"init\",\n  \"capabilities\": { \"tokens\": \"v1\", \"diff\": \"v1\" },\n  \"theme\": { \"mode\": \"dual\", \"dark\": \"github-dark\", \"light\": \"github-light\" }\n}`}
                language="json"
              />
            </CodePanel>
          </section>

          <section>
            <h2 id="token-highlighting" className="text-xl font-semibold">
              Token-level highlighting
            </h2>
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
              Token spans carry color and style metadata for terminal renderers. Streaming tokens arrive line by
              line to minimize flicker.
            </p>
            <CodePanel title="Token output">
              <StreamingCodeBlock className="code-panel-block" code={tokenSnippet} language="json" />
            </CodePanel>
          </section>

          <section>
            <h2 id="diffs" className="text-xl font-semibold">
              Diffs in terminal
            </h2>
            <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
              Unified diff semantics are baked into patches so terminals can render additions, removals, and
              context lines without re-parsing content.
            </p>
            <CodePanel title="Unified diff">
              <StreamingCodeBlock className="code-panel-block" code={diffSnippet} language="diff" />
            </CodePanel>
          </section>

          <section>
            <h2 id="stability" className="text-xl font-semibold">
              Stability & guarantees
            </h2>
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <div className="rounded-2xl border border-border/60 bg-background p-5 shadow-sm">
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <ShieldCheck size={16} /> Schema versioning
                </div>
                <p className="mt-2 text-sm text-muted-foreground">
                  Event shapes remain backward compatible. Consumers should ignore unknown fields to stay
                  resilient across minor releases.
                </p>
              </div>
              <div className="rounded-2xl border border-border/60 bg-background p-5 shadow-sm">
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <Layers size={16} /> Deterministic output
                </div>
                <p className="mt-2 text-sm text-muted-foreground">
                  Identical inputs yield identical patches. This enables replay testing, diff validation, and
                  deterministic TUI output.
                </p>
              </div>
            </div>
          </section>

          <section className="rounded-2xl border border-border/60 bg-background p-6 shadow-sm">
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div>
                <h2 id="cta" className="text-lg font-semibold">
                  Ready to build something real?
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Explore the reference implementation and start streaming into your terminal UI.
                </p>
              </div>
              <Button asChild className="w-fit">
                <Link href="/demo">
                  Open the StreamMDX demo <ArrowRight size={16} />
                </Link>
              </Button>
            </div>
          </section>
        </div>
      </DocsShell>
    </div>
  );
}
