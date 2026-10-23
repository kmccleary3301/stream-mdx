import { createBrowserPreviewController } from "/preview/index.mjs";

const status = document.querySelector("#status");
const preview = document.querySelector("#preview");
const revise = document.querySelector("#revise");
let revision = 0;

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
    ];
    if (state.error !== null) lines.push(`error (${identity(state.error.identity)}): ${state.error.message}`);
    status.textContent = lines.join("\n");
  },
});

function filesFor(nextRevision) {
  return new Map([
    [
      "main.tsx",
      `import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
createRoot(document.getElementById("root")).render(<App revision={${JSON.stringify(`r${nextRevision}`)}} />);`,
    ],
    [
      "App.tsx",
      `import React, { useState } from "react";
export function App({ revision }) {
  const [count, setCount] = useState(0);
  return <main className="card"><p className="eyebrow">${`r${nextRevision}`}</p><h2>Isolated project output</h2><p>Revision: {revision}</p><button onClick={() => setCount(count + 1)}>Local count: {count}</button></main>;
}`,
    ],
    [
      "styles.css",
      ".card{padding:24px;border-radius:12px;background:#eff6ff;color:#172554}.eyebrow{font:700 12px ui-monospace,monospace;text-transform:uppercase;letter-spacing:.12em}button{background:#1d4ed8;color:white}",
    ],
  ]);
}

function compileRevision(nextRevision) {
  return controller.request({
    generation: "local-demo",
    revision: `r${nextRevision}`,
    files: filesFor(nextRevision),
    entry: "main.tsx",
  });
}

revise.addEventListener("click", () => {
  revision += 1;
  void compileRevision(revision);
});
void compileRevision(revision);
