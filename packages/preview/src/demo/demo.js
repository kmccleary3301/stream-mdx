import { createBrowserPreviewController } from "/preview/index.mjs";

const status = document.querySelector("#status");
const preview = document.querySelector("#preview");
const reviseStyles = document.querySelector("#revise-styles");
const reviseCode = document.querySelector("#revise-code");
let revision = 0;
let codeVersion = 0;
let alternateStyles = false;

const controller = createBrowserPreviewController(preview, {
  wasmURL: new URL("/preview/esbuild.wasm", location.href),
  reactRuntimeURL: new URL("/preview/vendor/react-core.mjs", location.href),
  onState(state) {
    const identity = (value) => value === null ? "—" : `${value.generation}/${value.revision}`;
    const lines = [
      `requested: ${identity(state.requested)}`,
      `compiled: ${identity(state.compiled)}`,
      `candidate-ready: ${identity(state.candidateReady)}`,
      `visible: ${identity(state.visible)}`,
      `styles-updated: ${identity(state.styleResult?.identity ?? null)}`,
    ];
    if (state.error !== null) lines.push(`error (${identity(state.error.identity)}): ${state.error.message}`);
    status.textContent = lines.join("\n");
  },
});

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
  return <main className="card"><PreviewCard count={count} codeVersion=${JSON.stringify(`r${nextCodeVersion}`)} /><button onClick={() => setCount((value) => value + 1)}>Local count: {count}</button></main>;
}`,
    ],
    [
      "components/PreviewCard.tsx",
      `import React from "react";
import { labelFor } from "../lib/labels";
export function PreviewCard({ count, codeVersion }) {
  return <section><p className="eyebrow">{labelFor(codeVersion)}</p><h2>Isolated project output</h2><p>State count: {count}</p></section>;
}`,
    ],
    ["lib/labels.ts", 'export function labelFor(codeVersion: string) { return `Code track: ${codeVersion}`; }'],
    [
      "styles.css",
      `.card{padding:24px;border-radius:12px;background:${nextAlternateStyles ? "#fef3c7" : "#eff6ff"};color:#172554}section{padding:12px;border:1px solid #94a3b8;border-radius:8px}.eyebrow{font:700 12px ui-monospace,monospace;text-transform:uppercase;letter-spacing:.12em}button{margin-top:12px;background:${nextAlternateStyles ? "#b45309" : "#1d4ed8"};color:white}`,
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
compileRevision();

