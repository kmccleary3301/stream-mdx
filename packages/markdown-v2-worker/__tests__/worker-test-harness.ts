import { EventEmitter } from "node:events";
import type { WorkerIn, WorkerOut } from "@stream-mdx/core";
import type { Block, HtmlTreeNode, InlineNode, NodeSnapshot } from "@stream-mdx/core";

class FakeWorkerGlobal extends EventEmitter {
  onmessage: ((event: MessageEvent<WorkerIn>) => void | Promise<void>) | null = null;

  async dispatch(event: WorkerIn): Promise<void> {
    await this.onmessage?.({ data: event } as MessageEvent<WorkerIn>);
  }
}

let workerScope: FakeWorkerGlobal | null = null;
let activeQueue: WorkerOut[] | null = null;

async function waitForAsyncWorkerMessages(queue: WorkerOut[], maxWaitMs = 50): Promise<void> {
  const deadline = Date.now() + maxWaitMs;
  let lastLength = queue.length;
  let idleTicks = 0;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (queue.length === lastLength) {
      idleTicks += 1;
    } else {
      idleTicks = 0;
      lastLength = queue.length;
    }
    if (idleTicks >= 2) {
      break;
    }
  }
}

async function ensureWorkerLoaded(): Promise<FakeWorkerGlobal> {
  workerScope = new FakeWorkerGlobal();
  (globalThis as any).self = workerScope;
  (globalThis as any).postMessage = (msg: WorkerOut) => {
    if (activeQueue) {
      activeQueue.push(msg);
      return;
    }
    // Tests only care about messages tied to the active dispatch; drop late emissions.
  };

  // Force a fresh worker module instance so each test file can own its worker scope.
  await import(`../src/worker?testHarness=${Date.now()}-${Math.random().toString(16).slice(2)}`);
  return workerScope;
}

export interface WorkerHarness {
  send(message: WorkerIn): Promise<WorkerOut[]>;
}

export async function createWorkerHarness(): Promise<WorkerHarness> {
  const scope = await ensureWorkerLoaded();
  return {
    async send(message: WorkerIn) {
      // A real postMessage delivers every WorkerIn as its own task. Without that boundary a long
      // send loop is one job, and jsdom's WeakRef-backed node-iterator set (DOMPurify creates one
      // per sanitize) keeps every sanitized document alive until the job ends.
      await new Promise<void>((resolve) => setImmediate(resolve));
      const queue: WorkerOut[] = [];
      activeQueue = queue;
      try {
        await scope.dispatch(message);
        if (message.type === "TOKENIZE_RANGE") {
          await waitForAsyncWorkerMessages(queue);
        }
      } finally {
        activeQueue = null;
      }
      return queue;
    },
  };
}

function mergeAdjacentText(nodes: readonly InlineNode[]): unknown[] {
  const merged: Array<Record<string, unknown>> = [];
  for (const node of nodes) {
    const projected: Record<string, unknown> = { ...node };
    if ("children" in node && Array.isArray(node.children)) {
      projected.children = mergeAdjacentText(node.children);
    }
    const previous = merged.at(-1);
    if (node.kind === "text" && previous?.kind === "text") {
      previous.text = `${String(previous.text)}${node.text}`;
      const previousRange = previous.sourceRange as { from: number; to: number } | undefined;
      const nextRange = node.sourceRange;
      if (previousRange && nextRange) previous.sourceRange = { from: previousRange.from, to: nextRange.to };
      else delete previous.sourceRange;
    } else {
      merged.push(projected);
    }
  }
  return merged;
}

/** Stable authored fields exposed by the cold RendererStore export. */
export function projectConsumerBlocks(blocks: readonly Block[]): unknown[] {
  function projectBlock(block: Block): unknown {
    const meta = block.payload.meta;
    const children: unknown[] = [];
    const prepared = meta?.preparedNested as { children?: readonly NodeSnapshot[] } | undefined;
    if (prepared?.children) children.push(...prepared.children.flatMap(projectNode));
    for (const key of ["htmlTree", "htmlParagraphTree"]) {
      const tree = meta?.[key] as HtmlTreeNode[] | undefined;
      if (Array.isArray(tree)) children.push(...tree.flatMap(projectHtmlTreeNode));
    }
    return {
      type: block.type,
      raw: block.payload.raw,
      range: block.payload.range,
      isFinalized: block.isFinalized,
      inline: mergeAdjacentText(block.payload.inline ?? []),
      children,
    };
  }

  function projectNode(node: NodeSnapshot): unknown[] {
    const block = node.props?.block as Block | undefined;
    if (block) return [projectBlock(block)];
    return node.children.flatMap(projectNode);
  }

  function projectHtmlTreeNode(node: HtmlTreeNode): unknown[] {
    if (node.kind === "block") return [projectBlock(node.block)];
    return node.kind === "element" || node.kind === "component" ? node.children.flatMap(projectHtmlTreeNode) : [];
  }

  return blocks.map(projectBlock);
}

/** Root-only variant for failures owned by the nested cold exporter. */
export function projectConsumerRoots(blocks: readonly Block[]): unknown[] {
  return blocks.map((block) => ({
    type: block.type,
    raw: block.payload.raw,
    range: block.payload.range,
    isFinalized: block.isFinalized,
    inline: mergeAdjacentText(block.payload.inline ?? []),
  }));
}
