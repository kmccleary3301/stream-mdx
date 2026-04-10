import { createWorkerThread } from "stream-mdx/worker/node";
import { createSnapshotStore } from "@stream-mdx/tui";

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
  const lines = [];

  for (const block of blocks) {
    if (block.type === "heading") {
      const level = Number(block?.payload?.meta?.level ?? 1);
      lines.push(`${"#".repeat(Math.max(1, Math.min(level, 6)))} ${block.payload.raw}`);
      lines.push("");
      continue;
    }

    if (block.type === "list") {
      const items = Array.isArray(block.payload?.items) ? block.payload.items : [];
      if (items.length > 0) {
        for (const item of items) {
          const text = typeof item?.raw === "string" ? item.raw : "";
          lines.push(`- ${text}`);
        }
      } else {
        lines.push(block.payload.raw);
      }
      lines.push("");
      continue;
    }

    if (block.type === "blockquote") {
      lines.push(`> ${block.payload.raw}`);
      lines.push("");
      continue;
    }

    if (block.type === "code") {
      lines.push("```");
      lines.push(block.payload.raw);
      lines.push("```");
      lines.push("");
      continue;
    }

    lines.push(block.payload.raw);
    lines.push("");
  }

  process.stdout.write("\x1bc");
  process.stdout.write(lines.join("\n"));
}

async function main() {
  const worker = createWorkerThread({ stdout: true, stderr: true });
  const store = createSnapshotStore();
  const chunks = SAMPLE.match(/.{1,48}/gs) ?? [SAMPLE];

  worker.on("message", (msg) => {
    if (msg.type === "PATCH") {
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
    initialContent: "",
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
