import { createWorkerThread } from "stream-mdx/worker/node";
import { createSnapshotStore } from "@stream-mdx/tui";
import { STREAM_MDX_SCHEMA_VERSION } from "stream-mdx/core";

const SAMPLE = [
  "# Terminal preview",
  "",
  "This is a **minimal** StreamMDX TUI example.",
  "",
  "- worker-thread parsing",
  "- patch application through the TUI snapshot store",
  "- simple terminal rendering from `Block[]`",
  "",
  "```ts",
  "export function add(a: number, b: number) {",
  "  return a + b;",
  "}",
  "```",
  "",
  "> Final rendering is owned by the terminal consumer.",
  "",
].join("\n");

function renderBlocks(blocks) {
  process.stdout.write("\x1bc");
  process.stdout.write(blocks.map((block) => block.payload.raw).join("\n\n"));
}

async function main() {
  const worker = createWorkerThread({ stdout: true, stderr: true });
  const store = createSnapshotStore();
  let generation = null;
  const chunks = SAMPLE.match(/.{1,48}/gs) ?? [SAMPLE];

  worker.on("message", (msg) => {
    if (msg.type === "INITIALIZED") {
      if (
        msg.schemaVersion !== STREAM_MDX_SCHEMA_VERSION ||
        !Number.isSafeInteger(msg.generation) ||
        msg.generation < 0 ||
        msg.snapshot.inputSource?.generation !== msg.generation ||
        typeof msg.snapshot.inputSource?.raw !== "string"
      ) {
        throw new Error("Incompatible worker initialization: canonical input baseline is missing or invalid");
      }
      store.setSnapshot(msg.snapshot);
      generation = msg.generation;
      return;
    }
    if (msg.type === "PATCH") {
      if (msg.generation !== generation) return;
      store.applyPatches(msg.patches);
      renderBlocks(store.getBlocks());
      return;
    }

    if (msg.type === "ERROR") {
      console.error("[stream-mdx:tui-minimal] worker error:", msg.message);
    }
  });

  worker.postMessage({
    type: "INIT",
    schemaVersion: STREAM_MDX_SCHEMA_VERSION,
    docPlugins: {
      tables: true,
      html: true,
      mdx: false,
      math: false,
      footnotes: true,
    },
    mdx: { compileMode: "server" },
    prewarmLangs: ["typescript"],
  });

  for (const chunk of chunks) {
    worker.postMessage({ type: "APPEND", text: chunk });
    await new Promise((resolve) => setTimeout(resolve, 60));
  }

  worker.postMessage({ type: "FINALIZE" });
  await new Promise((resolve) => setTimeout(resolve, 250));
  await worker.terminate();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
