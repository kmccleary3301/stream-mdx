import { Footer } from "@/components/footer";
import { CopyButton } from "@/components/copy-button";
import * as FadeIn from "@/components/motion/staggers/fade";
import { Button } from "@/components/ui/button";
import { Link } from "next-view-transitions";
import { Blocks, Braces, ShieldCheck, Sparkles, TerminalSquare, Wand2 } from "lucide-react";

const Spacer = ({ size = "md" }: { size?: "sm" | "md" | "lg" }) => {
  const marginTop = size === "lg" ? 56 : size === "sm" ? 20 : 32;
  return <div style={{ marginTop }} />;
};

export default function Home() {
  const featureTiles = [
    {
      title: "Incremental Shiki",
      body: "Highlight code blocks as they stream without flicker or layout shifts.",
      icon: Sparkles,
      accent: "text-cyan-600 dark:text-cyan-400 bg-cyan-500/10 border-cyan-500/30",
    },
    {
      title: "Full MDX support",
      body: "Import and render React components directly within your markdown stream.",
      icon: Braces,
      accent: "text-violet-600 dark:text-violet-400 bg-violet-500/10 border-violet-500/30",
    },
    {
      title: "HTML overrides",
      body: "Map standard markdown elements to your design system components.",
      icon: Wand2,
      accent: "text-amber-600 dark:text-amber-400 bg-amber-500/10 border-amber-500/30",
    },
    {
      title: "Math & Mermaid",
      body: "First-class KaTeX and Mermaid diagrams via optional plugins.",
      icon: Blocks,
      accent: "text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 border-emerald-500/30",
    },
    {
      title: "Format anticipation",
      body: "Regex-based plugins to predict and format content early.",
      icon: Sparkles,
      accent: "text-sky-600 dark:text-sky-400 bg-sky-500/10 border-sky-500/30",
    },
    {
      title: "Security model",
      body: "Built-in sanitization and CSP-friendly rendering for untrusted output.",
      icon: ShieldCheck,
      accent: "text-rose-600 dark:text-rose-400 bg-rose-500/10 border-rose-500/30",
    },
  ];

  return (
    <FadeIn.Container>
      <FadeIn.Item>
        <div className="mx-auto flex max-w-3xl flex-col items-center text-center">
          <h1 className="text-4xl font-semibold tracking-tight md:text-5xl">StreamMDX</h1>
          <p className="mt-3 text-base text-muted-old md:text-lg">
            High-performance streaming Markdown/MDX renderer for React.
          </p>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
            <Button asChild size="sm">
              <Link href="/demo">Open Demo</Link>
            </Button>
            <Button asChild size="sm" variant="outline">
              <Link href="/docs">Read Docs</Link>
            </Button>
          </div>
          <div className="mt-4 inline-flex items-center gap-2 rounded-lg border border-border/60 bg-background/40 px-3 py-2 text-sm shadow-sm">
            <span className="text-muted-old">$</span>
            <code>npm install stream-mdx</code>
            <CopyButton text="npm install stream-mdx" />
          </div>
        </div>
      </FadeIn.Item>
      <Spacer size="lg" />
      <FadeIn.Item>
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
          <div className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-old">Proof, not promises</div>
          <div className="grid gap-4 md:grid-cols-3">
            <div className="rounded-lg border border-border/60 bg-background/40 p-5">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <span className="flex h-7 w-7 items-center justify-center rounded-md border border-indigo-500/30 bg-indigo-500/10 text-indigo-600 dark:text-indigo-400">
                  <TerminalSquare size={14} />
                </span>
                Worker-first parsing
              </div>
              <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                <li>Off-main-thread MDX compilation.</li>
                <li>Zero-latency UI interactions.</li>
                <li>Incremental AST hydration.</li>
              </ul>
              <Link className="mt-3 inline-block text-sm text-foreground/80 underline decoration-1 decoration-gray-a4 underline-offset-2" href="/docs/architecture">
                Architecture
              </Link>
            </div>
            <div className="rounded-lg border border-border/60 bg-background/40 p-5">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <span className="flex h-7 w-7 items-center justify-center rounded-md border border-teal-500/30 bg-teal-500/10 text-teal-600 dark:text-teal-400">
                  <Blocks size={14} />
                </span>
                Patch-based rendering
              </div>
              <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                <li>Tail block updates only.</li>
                <li>Stable finalized blocks.</li>
                <li>Minimal DOM reflows.</li>
              </ul>
              <Link className="mt-3 inline-block text-sm text-foreground/80 underline decoration-1 decoration-gray-a4 underline-offset-2" href="/demo">
                View demo
              </Link>
            </div>
            <div className="rounded-lg border border-border/60 bg-background/40 p-5">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <span className="flex h-7 w-7 items-center justify-center rounded-md border border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400">
                  <ShieldCheck size={14} />
                </span>
                Output locked
              </div>
              <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                <li>HTML snapshot locks.</li>
                <li>Regression protection.</li>
                <li>Incremental checkouts.</li>
              </ul>
              <Link className="mt-3 inline-block text-sm text-foreground/80 underline decoration-1 decoration-gray-a4 underline-offset-2" href="/docs/testing">
                Testing docs
              </Link>
            </div>
          </div>
        </div>
      </FadeIn.Item>
      <Spacer size="lg" />
      <FadeIn.Item>
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
          <div className="max-w-2xl">
            <div className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-old">Feature highlights</div>
            <p className="mt-3 text-sm text-muted-foreground">
              Everything you need for production-grade streaming MDX.
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            {featureTiles.map((item) => (
              <div key={item.title} className="rounded-lg border border-border/60 bg-background/40 p-4">
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <span className={`flex h-7 w-7 items-center justify-center rounded-md border ${item.accent}`}>
                    <item.icon size={14} />
                  </span>
                  {item.title}
                </div>
                <p className="mt-2 text-sm text-muted-foreground">{item.body}</p>
              </div>
            ))}
          </div>
        </div>
      </FadeIn.Item>
      <Spacer size="lg" />
      <FadeIn.Item>
        <Footer />
      </FadeIn.Item>
    </FadeIn.Container>
  );
}
