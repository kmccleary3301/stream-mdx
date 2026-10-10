"use client";

import { useEffect, useMemo, useState } from "react";
import { Link } from "next-view-transitions";

import { StreamingMarkdownDemoV2 } from "@/components/screens/streaming-markdown-demo-v2";
import type { StudioSampleWithText } from "@/lib/studio-samples";
import { cn } from "@/lib/utils";

const capabilityRows = [
  ["input", "sample text arrives as ordered chunks"],
  ["worker", "parse and enrichment stay off the main surface"],
  ["queue", "patch batches absorb cadence pressure"],
  ["commit", "renderer applies visible-first updates"],
  ["final", "DOM converges without reordered code/list structure"],
] as const;

const proofRows = [
  { label: "Scheduler", value: "latency / throughput", detail: "Existing controls remain inside the live renderer." },
  { label: "Fixtures", value: "5 stress samples", detail: "Prose, tables, code, footnotes, and mixed markdown are selectable." },
  { label: "Guardrails", value: "regression-backed", detail: "The same renderer path is exercised by HTML and style invariants." },
  { label: "Compatibility", value: "/demo retained", detail: "The legacy route continues to resolve to the same Studio engine." },
];

export function StudioPageClient({ samples }: { samples: StudioSampleWithText[] }) {
  const [activeSampleId, setActiveSampleId] = useState(samples[0]?.id ?? "");
  const [hydrated, setHydrated] = useState(false);
  const activeSample = useMemo(
    () => samples.find((sample) => sample.id === activeSampleId) ?? samples[0] ?? null,
    [activeSampleId, samples],
  );

  useEffect(() => {
    setHydrated(true);
  }, []);

  if (!activeSample) {
    return (
      <main className="mx-auto w-full max-w-screen-xl px-4 py-10 md:px-6">
        <section className="studio-instrument px-5 py-6">
          <p className="text-sm text-muted-foreground">No Studio samples were available.</p>
        </section>
      </main>
    );
  }

  return (
    <main className="studio-page mx-auto flex w-full max-w-screen-2xl flex-col gap-6 px-4 py-8 md:px-6 md:py-10">
      <section className="studio-hero" aria-labelledby="studio-title">
        <div className="studio-hero__copy">
          <div className="route-kicker">Studio / Control surface</div>
          <h1 id="studio-title">Streamed markdown with the runtime still visible.</h1>
          <p>
            Select a fixture, let it stream through the production renderer, and inspect the same cadence, scheduler, queue, highlighting,
            and final convergence behavior that powers the docs and benchmark routes.
          </p>
          <div className="studio-hero__actions" aria-label="Related StreamMDX surfaces">
            <Link href="/benchmarks" className="studio-action studio-action--primary">
              Compare benchmarks
            </Link>
            <Link href="/protocol" className="studio-action">
              Inspect protocol
            </Link>
          </div>
        </div>

        <div className="studio-schematic" aria-label="Streaming pipeline">
          {capabilityRows.map(([label, detail], index) => (
            <div key={label} className="studio-schematic__row">
              <span className="studio-schematic__index">{String(index + 1).padStart(2, "0")}</span>
              <span className="studio-schematic__label">{label}</span>
              <span className="studio-schematic__detail">{detail}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="studio-proof-grid" aria-label="Studio proof points">
        {proofRows.map((row) => (
          <div key={row.label} className="studio-proof-cell">
            <div className="studio-proof-cell__label">{row.label}</div>
            <div className="studio-proof-cell__value">{row.value}</div>
            <p>{row.detail}</p>
          </div>
        ))}
      </section>

      <section className="studio-instrument" aria-labelledby="studio-sample-title">
        <div className="studio-instrument__header">
          <div>
            <div className="route-kicker">Sample selector</div>
            <h2 id="studio-sample-title">{activeSample.label}</h2>
          </div>
          <p>{activeSample.summary}</p>
        </div>

        <div className="studio-sample-grid" aria-label="Renderer stress samples" data-studio-ready={hydrated ? "true" : "false"}>
          {samples.map((sample) => {
            const active = sample.id === activeSample.id;
            return (
              <button
                key={sample.id}
                type="button"
                className={cn("studio-sample-button", active && "is-active")}
                onClick={() => setActiveSampleId(sample.id)}
                aria-pressed={active}
              >
                <span className="studio-sample-button__label">{sample.label}</span>
                <span className="studio-sample-button__summary">{sample.summary}</span>
                <span className="studio-sample-button__tags" aria-label={`${sample.label} emphasis`}>
                  {sample.emphasis.map((tag) => (
                    <span key={tag}>{tag}</span>
                  ))}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="studio-renderer-shell" aria-label={`${activeSample.label} live renderer`}>
        <div className="studio-renderer-shell__header">
          <div>
            <div className="route-kicker">Live renderer</div>
            <h2>{activeSample.label}</h2>
          </div>
          <p>
            The renderer below is the existing `StreamingMarkdownDemoV2` engine. The shell changes framing and sample selection only; it does
            not rewrite parser, worker, scheduler, or commit behavior.
          </p>
        </div>
        <StreamingMarkdownDemoV2 key={activeSample.id} className="studio-live-renderer" fullText={activeSample.text} />
      </section>
    </main>
  );
}
