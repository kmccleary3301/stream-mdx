import { Footer } from "@/components/footer";
import * as FadeIn from "@/components/motion/staggers/fade";
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
        </div>
      </FadeIn.Item>
      <Spacer />
      <FadeIn.Item>
        <Footer />
      </FadeIn.Item>
    </FadeIn.Container>
  );
}

