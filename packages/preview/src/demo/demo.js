import { createBrowserPreviewVariantsController } from "/preview/index.mjs";

const status = document.querySelector("#status");
const preview = document.querySelector("#preview");
const hostAudit = document.querySelector("#host-style-audit");
const reviseStyles = document.querySelector("#revise-styles");
const reviseCode = document.querySelector("#revise-code");
let revision = 0;
let codeVersion = 0;
let alternateStyles = false;
const stateByVariant = new Map();

function hostStyleSnapshot() {
  const body = getComputedStyle(document.body);
  const title = getComputedStyle(document.querySelector("h1"));
  return JSON.stringify({
    bodyColor: body.color,
    bodyFont: body.fontFamily,
    bodyMargin: body.margin,
    bodyBackground: body.backgroundColor,
    titleMargin: title.marginBlockStart,
  });
}

const hostStyleBaseline = hostStyleSnapshot();

function updateHostStyleAudit() {
  const unchanged = hostStyleSnapshot() === hostStyleBaseline;
  hostAudit.textContent = `Host computed styles ${unchanged ? "unchanged" : "changed"}: ${hostStyleBaseline}`;
  hostAudit.dataset.result = unchanged ? "pass" : "fail";
}

const controller = createBrowserPreviewVariantsController(
  preview,
  [
    { name: "Cool", css: ":root{--preview-card-background:#eff6ff;--preview-button-background:#1d4ed8}" },
    { name: "Warm", css: ":root{--preview-card-background:#fef3c7;--preview-button-background:#b45309}" },
  ],
  {
    wasmURL: new URL("/preview/deps/esbuild-wasm/esbuild.wasm", location.href),
    reactRuntimeURL: new URL("/preview/vendor/react-core.mjs", location.href),
    tailwindAssetsURL: new URL("/preview/deps/tailwindcss/", location.href),
    onState(name, state) {
      stateByVariant.set(name, state);
      const identity = (value) => value === null ? "—" : `${value.generation}/${value.revision}`;
      const lines = [...stateByVariant.entries()].map(([variant, current]) => {
        const summary = [
          `${variant}: requested ${identity(current.requested)}`,
          `compiled ${identity(current.compiled)}`,
          `candidate-ready ${identity(current.candidateReady)}`,
          `visible ${identity(current.visible)}`,
          `styles-updated ${identity(current.styleResult?.identity ?? null)}`,
        ].join(" · ");
        return current.error === null ? summary : `${summary} · error (${identity(current.error.identity)}): ${current.error.message}`;
      });
      status.textContent = lines.join("\n");
      updateHostStyleAudit();
    },
  },
);

function filesFor(nextCodeVersion, nextAlternateStyles) {
  return new Map([
    [
      "main.tsx",
      `import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
createRoot(document.getElementById("root")).render(<App />);`,
    ],
    [
      "App.tsx",
      `import React, { useState } from "react";
import { PreviewCard } from "./components/PreviewCard";
export function App() {
  const [count, setCount] = useState(0);
  return <main className="card rounded-2xl p-6 text-slate-900 shadow-lg"><PreviewCard count={count} codeVersion=${JSON.stringify(`r${nextCodeVersion}`)} /><button className="preview-button mt-3 rounded-lg px-4 py-2 text-white" onClick={() => setCount((value) => value + 1)}>Local count: {count}</button></main>;
}`,
    ],
    [
      "components/PreviewCard.tsx",
      `import React from "react";
import { labelFor } from "../lib/labels";
export function PreviewCard({ count, codeVersion }) {
  return <section><p className="eyebrow text-xs font-bold uppercase tracking-widest">{labelFor(codeVersion)}</p><h2 className="mt-3 text-xl font-semibold">Isolated project output</h2><p className="mt-2">State count: {count}</p></section>;
}`,
    ],
    ["lib/labels.ts", 'export function labelFor(codeVersion: string) { return `Code track: ${codeVersion}`; }'],
    [
      "styles.css",
      `@import "tailwindcss";
.card{border:1px solid #94a3b8;background:var(--preview-card-background)}
.preview-button{background-color:var(--preview-button-background)}
.eyebrow{color:${nextAlternateStyles ? "#b45309" : "#1d4ed8"}}`,
    ],
  ]);
}

function compileRevision() {
  void controller.request({
    generation: "local-demo",
    revision: `r${revision}`,
    files: filesFor(codeVersion, alternateStyles),
    entry: "main.tsx",
  });
}

reviseStyles.addEventListener("click", () => {
  revision += 1;
  alternateStyles = !alternateStyles;
  compileRevision();
});
reviseCode.addEventListener("click", () => {
  revision += 1;
  codeVersion += 1;
  compileRevision();
});
updateHostStyleAudit();
compileRevision();
