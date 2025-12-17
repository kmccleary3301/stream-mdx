"use client";

import { useMemo, useState } from "react";
import { StreamingMarkdown } from "stream-mdx";

const sample = `# StreamMDX demo

This page renders streaming **Markdown**.

- tables
- math: $R_{\\rho\\sigma\\mu\\nu}$
- code:

\`\`\`python
print("hello world")
\`\`\`
`;

export default function DemoPage() {
  const [text, setText] = useState(sample);
  const [features, setFeatures] = useState(() => ({ tables: true, html: true, math: true, mdx: true }));
  const mdxCompileMode = useMemo(() => (features.mdx ? ("worker" as const) : undefined), [features.mdx]);
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
  const workerUrl = `${basePath}/workers/markdown-worker.js`;

  return (
    <main style={{ maxWidth: 960, margin: "0 auto", padding: 24, display: "grid", gap: 16 }}>
      <h1>Demo</h1>
      <p>
        This demo expects a hosted worker at <code>{workerUrl}</code>.
      </p>
      <fieldset style={{ border: "1px solid rgba(0,0,0,.12)", borderRadius: 8, padding: 12 }}>
        <legend style={{ padding: "0 6px" }}>Features</legend>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
          {(
            [
              ["tables", "Tables"],
              ["html", "HTML"],
              ["math", "Math"],
              ["mdx", "MDX"],
            ] as const
          ).map(([key, label]) => (
            <label key={key} style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                type="checkbox"
                checked={features[key]}
                onChange={(e) => setFeatures((prev) => ({ ...prev, [key]: e.target.checked }))}
              />
              {label}
            </label>
          ))}
        </div>
        {features.mdx ? (
          <div style={{ marginTop: 8, fontSize: 13, opacity: 0.8 }}>
            MDX compile mode: <code>{mdxCompileMode}</code>
          </div>
        ) : null}
      </fieldset>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={10}
        style={{ width: "100%", padding: 12, borderRadius: 8, border: "1px solid rgba(0,0,0,.2)" }}
      />
      <div style={{ border: "1px solid rgba(0,0,0,.12)", borderRadius: 8, padding: 16 }}>
        <StreamingMarkdown
          text={text}
          worker={workerUrl}
          features={features}
          mdxCompileMode={mdxCompileMode}
        />
      </div>
    </main>
  );
}
