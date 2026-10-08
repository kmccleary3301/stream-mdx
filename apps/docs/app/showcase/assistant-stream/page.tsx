import type { Metadata } from "next";
import { readShowcaseFile } from "@/lib/showcase";
import { AssistantStreamClient } from "@/components/screens/showcase/assistant-stream-client";

export const metadata: Metadata = {
  title: "Streaming Assistant & Sandboxed Artifacts",
  description:
    "Executable chat thread showcasing dual-engine streaming, math, Mermaid diagrams, custom code fence renderers, link safety, and sandboxed ArtifactFrame visualizations.",
};

export default async function AssistantStreamPage() {
  const content = await readShowcaseFile("assistant-stream.md");
  return <AssistantStreamClient fullContent={content} />;
}
