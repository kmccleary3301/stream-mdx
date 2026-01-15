import { Footer } from "@/components/footer";
import * as FadeIn from "@/components/motion/staggers/fade";
import { ARTICLE_ITEMS } from "@/content/articles";
import { Link } from "next-view-transitions";

const Spacer = () => <div style={{ marginTop: "24px" }} />;

export default function Home() {
  return (
    <FadeIn.Container>
      <FadeIn.Item>
        <div className="flex justify-between">
          <div>
            <h1>StreamMDX</h1>
            <h2 className="text-muted-old">A high-performance streaming Markdown/MDX renderer</h2>
          </div>
        </div>
      </FadeIn.Item>
      <Spacer />
      <FadeIn.Item>
        <p>
          This site is the public demo and documentation hub. Start with the interactive streaming demo, then browse the implementation details and API docs.
        </p>
      </FadeIn.Item>
      <Spacer />
      <FadeIn.Item>
        <div className="flex flex-col gap-2">
          <Link className="underline decoration-1 decoration-gray-a4 underline-offset-2" href="/demo">
            Open streaming demo
          </Link>
          <Link className="underline decoration-1 decoration-gray-a4 underline-offset-2" href="/docs">
            Read docs
          </Link>
          <Link className="underline decoration-1 decoration-gray-a4 underline-offset-2" href="/showcase">
            Explore showcase
          </Link>
        </div>
      </FadeIn.Item>
      <Spacer />
      <FadeIn.Item>
        <div className="rounded-lg border border-border/60 bg-background/40 p-4">
          <h3 className="text-base font-semibold">What StreamMDX focuses on</h3>
          <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            <li>Stable streaming output with minimal reflow.</li>
            <li>Configurable rendering (MDX, HTML, math, tables, plugins).</li>
            <li>Scheduling and backpressure tuned for low-latency updates.</li>
            <li>Regression and perf baselines to lock output consistency.</li>
          </ul>
        </div>
      </FadeIn.Item>
      <Spacer />
      <FadeIn.Item>
        <div className="flex flex-col gap-3">
          <h3 className="text-base font-semibold">Deep-dive articles</h3>
          <div className="grid gap-3 md:grid-cols-2">
            {ARTICLE_ITEMS.map((item) => (
              <Link
                key={item.slug}
                className="rounded-lg border border-border/60 bg-background/40 p-4 transition hover:border-border hover:bg-background/60"
                href={`/articles/${item.slug}`}
              >
                <div className="text-sm font-semibold">{item.title}</div>
                {item.description ? <div className="mt-1 text-sm text-muted-foreground">{item.description}</div> : null}
              </Link>
            ))}
          </div>
        </div>
      </FadeIn.Item>
      <Spacer />
      <FadeIn.Item>
        <Footer />
      </FadeIn.Item>
    </FadeIn.Container>
  );
}
