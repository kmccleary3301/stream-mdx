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
  return (
    <FadeIn.Container>
      <FadeIn.Item>
        <div className="route-panel-hero mx-auto flex max-w-5xl flex-col items-center px-6 py-10 text-center md:px-10 md:py-14">
          <div className="route-kicker">Worker-first streaming markdown</div>
          <h1 className="mt-4 max-w-4xl text-4xl font-semibold tracking-tight md:text-6xl">
            Stream Markdown and MDX without treating every update like a full rerender.
          </h1>
          <p className="mt-4 max-w-2xl text-base leading-relaxed text-muted-foreground md:text-lg">
            StreamMDX combines worker parsing, patch-based rendering, seeded regression gates, and a real benchmark surface for teams that
            need deterministic incremental behavior rather than cosmetic demos.
          </p>
          <div className="mt-5 flex flex-wrap items-center justify-center gap-2 text-xs text-muted-foreground">
            <span className="route-chip">Worker parser</span>
            <span className="route-chip">MDX + math + HTML</span>
            <span className="route-chip">Seeded regression suite</span>
            <span className="route-chip">Benchmark lab</span>
          </div>
          <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
            <Button asChild size="sm">
              <Link href="/demo">Open Demo</Link>
            </Button>
            <Button asChild size="sm" variant="outline">
              <Link href="/docs">Read Docs</Link>
            </Button>
            <Button asChild size="sm" variant="outline">
              <Link href="/benchmarks">View Benchmarks</Link>
            </Button>
          </div>
          <div className="route-panel mt-5 inline-flex items-center gap-2 px-3 py-2 text-sm shadow-sm">
            <span className="text-muted-old">$</span>
            <code>npm install stream-mdx</code>
            <CopyButton text="npm install stream-mdx" />
          </div>
        </div>
      </FadeIn.Item>
      <Spacer size="lg" />
      <FadeIn.Item>
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
          <div className="route-kicker">Proof, not promises</div>
          <div className="grid gap-4 md:grid-cols-3">
            <div className="route-grid-card p-5">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <span className="route-icon-box text-sky-700 dark:text-sky-300">
                  <TerminalSquare size={14} />
                </span>
                Worker-first parsing
              </div>
              <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                <li>Off-main-thread MDX compilation.</li>
                <li>Zero-latency UI interactions.</li>
                <li>Incremental AST hydration.</li>
              </ul>
              <Link
                className="mt-3 inline-block text-sm text-foreground/80 underline decoration-1 decoration-gray-a4 underline-offset-2"
                href="/docs/guides/architecture-and-internals"
              >
                Architecture
              </Link>
            </div>
            <div className="route-grid-card p-5">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <span className="route-icon-box text-amber-700 dark:text-amber-300">
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
            <div className="route-grid-card p-5">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <span className="route-icon-box text-emerald-700 dark:text-emerald-300">
                  <ShieldCheck size={14} />
                </span>
                Output locked
              </div>
              <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                <li>HTML snapshot locks.</li>
                <li>Regression protection.</li>
                <li>Incremental checkouts.</li>
              </ul>
              <Link
                className="mt-3 inline-block text-sm text-foreground/80 underline decoration-1 decoration-gray-a4 underline-offset-2"
                href="/docs/guides/testing-and-baselines"
              >
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
            <div className="route-kicker">Feature highlights</div>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              The public site now covers the integration surface, benchmark methodology, showcase articles, and the regression work that
              keeps the renderer honest.
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            {[
              {
                title: "Incremental Shiki",
                body: "Highlight code blocks as they stream without flicker or layout shifts.",
                icon: Sparkles,
                href: "/docs/guides/rendering-and-styling",
                cta: "Rendering guide",
              },
              {
                title: "Full MDX support",
                body: "Import and render React components directly within your markdown stream.",
                icon: Braces,
                href: "/docs/guides/mdx-and-html",
                cta: "MDX guide",
              },
              {
                title: "HTML overrides",
                body: "Map standard markdown elements to your design system components.",
                icon: Wand2,
                href: "/showcase/html-overrides",
                cta: "HTML showcase",
              },
              {
                title: "Math & Mermaid",
                body: "First-class KaTeX and Mermaid diagrams via optional plugins.",
                icon: Blocks,
                href: "/docs/guides/mermaid-diagrams",
                cta: "Mermaid guide",
              },
              {
                title: "Format anticipation",
                body: "Regex-based plugins to predict and format content early.",
                icon: Sparkles,
                href: "/docs/guides/format-anticipation",
                cta: "Format guide",
              },
              {
                title: "Security model",
                body: "Built-in sanitization and CSP-friendly rendering for untrusted output.",
                icon: ShieldCheck,
                href: "/docs/security-model",
                cta: "Security docs",
              },
            ].map((item) => (
              <div key={item.title} className="route-grid-card p-4">
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <span className="route-icon-box text-rose-700 dark:text-rose-300">
                    <item.icon size={14} />
                  </span>
                  {item.title}
                </div>
                <p className="mt-2 text-sm text-muted-foreground">{item.body}</p>
                <Link className="mt-3 inline-block text-sm text-foreground/80 underline decoration-1 decoration-gray-a4 underline-offset-2" href={item.href}>
                  {item.cta}
                </Link>
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
