import Link from "next/link";

import { DOC_SECTIONS } from "../../lib/docs";

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "260px 1fr", minHeight: "100vh" }}>
      <aside style={{ borderRight: "1px solid rgba(0,0,0,.12)", padding: 16 }}>
        <div style={{ display: "grid", gap: 8 }}>
          <Link href="/" style={{ fontWeight: 600, textDecoration: "none" }}>
            StreamMDX
          </Link>
          <Link href="/demo" style={{ textDecoration: "none", opacity: 0.85 }}>
            Demo
          </Link>
        </div>

        <nav style={{ marginTop: 16, display: "grid", gap: 16 }}>
          {DOC_SECTIONS.map((section) => (
            <section key={section.title} style={{ display: "grid", gap: 6 }}>
              <div style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: 0.08, opacity: 0.6 }}>
                {section.title}
              </div>
              <div style={{ display: "grid", gap: 4 }}>
                {section.items.map((item) => (
                  <Link
                    key={item.slug || "index"}
                    href={item.slug ? `/docs/${item.slug}` : "/docs"}
                    style={{ textDecoration: "none", opacity: 0.9 }}
                  >
                    {item.title}
                  </Link>
                ))}
              </div>
            </section>
          ))}
        </nav>
      </aside>

      <main style={{ padding: 24 }}>{children}</main>
    </div>
  );
}

