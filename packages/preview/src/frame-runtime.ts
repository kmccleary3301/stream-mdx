
const MAX_CHUNK_BYTES = 48 * 1024;

type FrameDocumentOptions = Readonly<{
  generation: string;
  capability: string;
  nonce: string;
  reactRuntimeURL: URL;
  reactRuntimeURLs: Readonly<
    Record<
      "react" | "react-dom" | "react-dom/client" | "react/jsx-runtime" | "react/jsx-dev-runtime",
      URL
    >
  >;
}>;

function runFrameRuntime(expectedGeneration: string, expectedCapability: string): void {
  const MAX_MESSAGE_BYTES = 64 * 1024;
  const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
  const encoder = new TextEncoder();
  let port: MessagePort | null = null;
  let latestCandidateId = 0;
  let pendingCandidate: {
    kind: "candidate" | "styles";
    candidateId: number;
    revision: string;
    javascriptBytes: number;
    cssBytes: number;
    javascriptChunks: ArrayBuffer[];
    cssChunks: ArrayBuffer[];
    receivedBytes: number;
    ready: boolean;
    javascript: string;
    css: string;
  } | null = null;
  let activeStyle: HTMLStyleElement | null = null;
  let activeRuntimeCandidate: { candidateId: number; revision: string } | null = null;
  let failedRuntimeCandidateId: number | null = null;

  function record(value: unknown): Record<string, unknown> | null {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  }

  function messageByteLength(message: Record<string, unknown>): number {
    try {
      const body = { ...message };
      const bytes = body.bytes;
      delete body.bytes;
      const envelopeSize = encoder.encode(JSON.stringify(body)).byteLength;
      const binarySize = bytes instanceof ArrayBuffer ? bytes.byteLength : 0;
      return envelopeSize + binarySize;
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  }

  function send(message: Record<string, unknown>): void {
    if (port === null || messageByteLength(message) > MAX_MESSAGE_BYTES) return;
    port.postMessage(message);
  }

  function sendFailure(candidateId: number, revision: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    send({
      type: "error",
      generation: expectedGeneration,
      candidateId,
      revision,
      message: message.slice(0, 4 * 1024),
    });
  }
  function reportRuntimeFailure(error: unknown): void {
    const candidate = activeRuntimeCandidate;
    if (
      candidate === null ||
      candidate.candidateId !== latestCandidateId ||
      failedRuntimeCandidateId === candidate.candidateId
    ) {
      return;
    }
    failedRuntimeCandidateId = candidate.candidateId;
    if (pendingCandidate?.candidateId === candidate.candidateId) pendingCandidate = null;
    sendFailure(candidate.candidateId, candidate.revision, error);
  }

  window.addEventListener("error", (event) => reportRuntimeFailure(event.error ?? event.message));
  window.addEventListener("unhandledrejection", (event) => reportRuntimeFailure(event.reason));

  function cleanupStaging(staging: HTMLDivElement, style: HTMLStyleElement, priorRoot: HTMLElement | null): void {
    staging.remove();
    style.remove();
    if (priorRoot !== null) priorRoot.id = "root";
  }
  function waitForRenderOpportunity(): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    let settled = false;
    let timeoutId = 0;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeoutId);
      resolve();
    };
    timeoutId = window.setTimeout(finish, 100);
    window.requestAnimationFrame(finish);
    return promise;
  }

  async function mountCandidate(candidate: NonNullable<typeof pendingCandidate>): Promise<void> {
    if (candidate.kind !== "candidate" || candidate.candidateId !== latestCandidateId || !candidate.ready) return;
    activeRuntimeCandidate = {
      candidateId: candidate.candidateId,
      revision: candidate.revision,
    };
    failedRuntimeCandidateId = null;
    const priorRoot = document.getElementById("root");
    if (priorRoot !== null) priorRoot.id = `prior-root-${candidate.candidateId}`;
    const staging = document.createElement("div");
    staging.id = "root";
    staging.hidden = true;
    document.body.append(staging);

    const style = document.createElement("style");
    style.media = "not all";
    style.textContent = candidate.css;
    document.head.append(style);

    const moduleURL = URL.createObjectURL(new Blob([candidate.javascript], { type: "text/javascript" }));
    try {
      const discardCandidate = () => {
        cleanupStaging(staging, style, priorRoot);
        send({
          type: "discarded",
          generation: expectedGeneration,
          candidateId: candidate.candidateId,
          revision: candidate.revision,
        });
        if (activeRuntimeCandidate?.candidateId === candidate.candidateId) activeRuntimeCandidate = null;
      };
      // Compiled output is executed from a per-candidate Blob module URL created at runtime.
      await import(moduleURL);
      if (candidate.candidateId !== latestCandidateId || failedRuntimeCandidateId === candidate.candidateId) {
        discardCandidate();
        return;
      }
      await waitForRenderOpportunity();
      if (candidate.candidateId !== latestCandidateId || failedRuntimeCandidateId === candidate.candidateId) {
        discardCandidate();
        return;
      }
      staging.hidden = false;
      priorRoot?.remove();
      if (activeStyle !== null) activeStyle.remove();
      style.media = "all";
      activeStyle = style;
      pendingCandidate = null;
      send({
        type: "visible",
        generation: expectedGeneration,
        candidateId: candidate.candidateId,
        revision: candidate.revision,
      });
    } catch (error) {
      cleanupStaging(staging, style, priorRoot);
      if (candidate.candidateId === latestCandidateId) pendingCandidate = null;
      sendFailure(candidate.candidateId, candidate.revision, error);
    } finally {
      URL.revokeObjectURL(moduleURL);
    }
  }

  function updateStyles(candidate: NonNullable<typeof pendingCandidate>): void {
    const runtime = activeRuntimeCandidate;
    if (candidate.candidateId !== latestCandidateId || !candidate.ready || candidate.kind !== "styles") return;
    if (activeStyle === null || runtime === null || failedRuntimeCandidateId === runtime.candidateId) {
      pendingCandidate = null;
      sendFailure(
        candidate.candidateId,
        candidate.revision,
        new Error("Preview stylesheet cannot update before a healthy preview is visible"),
      );
      return;
    }
    const style = document.createElement("style");
    style.media = "not all";
    style.textContent = candidate.css;
    document.head.append(style);
    style.media = "all";
    activeStyle.remove();
    activeStyle = style;
    activeRuntimeCandidate = {
      candidateId: candidate.candidateId,
      revision: candidate.revision,
    };
    failedRuntimeCandidateId = null;
    pendingCandidate = null;
    send({
      type: "styles-updated",
      generation: expectedGeneration,
      candidateId: candidate.candidateId,
      revision: candidate.revision,
    });
  }

  function decodeTransfer(candidate: NonNullable<typeof pendingCandidate>): boolean {
    const javascriptSize = candidate.javascriptChunks.reduce((total, chunk) => total + chunk.byteLength, 0);
    const cssSize = candidate.cssChunks.reduce((total, chunk) => total + chunk.byteLength, 0);
    if (
      javascriptSize !== candidate.javascriptBytes ||
      cssSize !== candidate.cssBytes ||
      candidate.receivedBytes !== candidate.javascriptBytes + candidate.cssBytes
    ) {
      pendingCandidate = null;
      sendFailure(candidate.candidateId, candidate.revision, new Error("Incomplete preview output transfer"));
      return false;
    }
    try {
      candidate.javascript = decodeChunks(candidate.javascriptChunks, javascriptSize);
      candidate.css = decodeChunks(candidate.cssChunks, cssSize);
      candidate.ready = true;
      return true;
    } catch (error) {
      pendingCandidate = null;
      sendFailure(candidate.candidateId, candidate.revision, error);
      return false;
    }
  }

  function decodeChunks(chunks: ArrayBuffer[], byteCount: number): string {
    const joined = new Uint8Array(byteCount);
    let offset = 0;
    for (const chunk of chunks) {
      const bytes = new Uint8Array(chunk);
      joined.set(bytes, offset);
      offset += bytes.byteLength;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(joined);
  }

  function receivePortMessage(value: unknown): void {
    const message = record(value);
    if (message === null || messageByteLength(message) > MAX_MESSAGE_BYTES) return;
    if (message.generation !== expectedGeneration || typeof message.type !== "string") return;

    if (message.type === "request") {
      if (!Number.isSafeInteger(message.candidateId) || (message.candidateId as number) < latestCandidateId) return;
      latestCandidateId = message.candidateId as number;
      pendingCandidate = null;
      return;
    }

    if (message.type === "start" || message.type === "styles-start") {
      const candidateId = message.candidateId;
      const revision = message.revision;
      const kind = message.type === "styles-start" ? "styles" : "candidate";
      const javascriptBytes = message.type === "styles-start" ? 0 : message.javascriptBytes;
      const cssBytes = message.cssBytes;
      if (
        !Number.isSafeInteger(candidateId) ||
        candidateId !== latestCandidateId ||
        typeof revision !== "string" ||
        !Number.isSafeInteger(javascriptBytes) ||
        !Number.isSafeInteger(cssBytes) ||
        (javascriptBytes as number) < 0 ||
        (cssBytes as number) < 0 ||
        (javascriptBytes as number) + (cssBytes as number) > MAX_OUTPUT_BYTES
      ) {
        return;
      }
      pendingCandidate = {
        kind,
        candidateId: candidateId as number,
        revision,
        javascriptBytes: javascriptBytes as number,
        cssBytes: cssBytes as number,
        javascriptChunks: [],
        cssChunks: [],
        receivedBytes: 0,
        ready: false,
        javascript: "",
        css: "",
      };
      return;
    }


    if (message.type === "chunk") {
      const candidate = pendingCandidate;
      const bytes = message.bytes;
      const section = message.section;
      if (
        candidate === null ||
        message.candidateId !== candidate.candidateId ||
        !(bytes instanceof ArrayBuffer) ||
        bytes.byteLength > MAX_CHUNK_BYTES ||
        (section !== "javascript" && section !== "css")
      ) {
        return;
      }
      const chunks = section === "javascript" ? candidate.javascriptChunks : candidate.cssChunks;
      if (!Number.isSafeInteger(message.index) || message.index !== chunks.length) return;
      chunks.push(bytes);
      candidate.receivedBytes += bytes.byteLength;
      if (candidate.receivedBytes > candidate.javascriptBytes + candidate.cssBytes) pendingCandidate = null;
      return;
    }

    if (message.type === "finish" || message.type === "styles-finish") {
      const candidate = pendingCandidate;
      const kind = message.type === "styles-finish" ? "styles" : "candidate";
      if (
        candidate === null ||
        message.candidateId !== candidate.candidateId ||
        candidate.kind !== kind ||
        !decodeTransfer(candidate)
      ) {
        return;
      }
      send({
        type: candidate.kind === "styles" ? "styles-ready" : "candidate-ready",
        generation: expectedGeneration,
        candidateId: candidate.candidateId,
        revision: candidate.revision,
      });
      return;
    }

    if (message.type === "commit" || message.type === "styles-commit") {
      const candidate = pendingCandidate;
      const kind = message.type === "styles-commit" ? "styles" : "candidate";
      if (
        candidate !== null &&
        candidate.kind === kind &&
        message.candidateId === candidate.candidateId &&
        candidate.ready
      ) {
        if (candidate.kind === "styles") updateStyles(candidate);
        else void mountCandidate(candidate);
      }
      return;
    }

    if (message.type === "discard") {
      if (pendingCandidate?.candidateId === message.candidateId) pendingCandidate = null;
    }
  }

  window.addEventListener("message", function onInitialization(event: MessageEvent<unknown>): void {
    if (event.source !== window.parent) return;
    const message = record(event.data);
    if (
      message === null ||
      message.type !== "init" ||
      message.generation !== expectedGeneration ||
      message.capability !== expectedCapability ||
      event.ports.length !== 1
    ) {
      return;
    }
    if (port !== null) {
      event.ports[0].close();
      return;
    }
    port = event.ports[0];
    port.onmessage = (portEvent: MessageEvent<unknown>) => receivePortMessage(portEvent.data);
    port.start();
    send({ type: "ready", generation: expectedGeneration });
  });
}

function escapeScriptText(value: unknown): string {
  return (JSON.stringify(value) ?? "null").replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

export function createFrameDocument(options: FrameDocumentOptions): string {
  const reactRuntimeSource = options.reactRuntimeURL.href;
  const runtimeSources = [
    reactRuntimeSource,
    ...Object.values(options.reactRuntimeURLs).map((url) => url.href),
  ].join(" ");
  const policy = [
    "default-src 'none'",
    `script-src 'nonce-${options.nonce}' blob: ${runtimeSources}`,
    "style-src 'unsafe-inline' data:",
    "img-src data:",
    "font-src data:",
    "media-src data:",
    "connect-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
  const importMap = escapeScriptText({
    imports: Object.fromEntries(
      Object.entries(options.reactRuntimeURLs).map(([specifier, url]) => [specifier, url.href]),
    ),
  });
  const runtime = `(${runFrameRuntime.toString()})(${escapeScriptText(options.generation)}, ${escapeScriptText(options.capability)});`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="${policy}"><script type="importmap" nonce="${options.nonce}">${importMap}</script><style nonce="${options.nonce}">html,body{margin:0;min-height:100%;font-family:system-ui,sans-serif}body{padding:12px;box-sizing:border-box}#root{min-height:1px}</style></head><body><div id="root"></div><script nonce="${options.nonce}">${runtime}</script></body></html>`;
}

export { MAX_CHUNK_BYTES };
