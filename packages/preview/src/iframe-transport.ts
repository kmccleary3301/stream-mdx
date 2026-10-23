import { createFrameDocument, MAX_CHUNK_BYTES } from "./frame-runtime";
import { PREVIEW_LIMITS } from "./types";
import type { PreviewCandidate, PreviewState, PreviewStyleUpdate, PreviewTransport } from "./types";

const encoder = new TextEncoder();

type ReactRuntimeSpecifier =
  | "react"
  | "react-dom"
  | "react-dom/client"
  | "react/jsx-runtime"
  | "react/jsx-dev-runtime";
type ReactRuntimeURLs = Readonly<Record<ReactRuntimeSpecifier, URL>>;

function createReactRuntimeURLs(coreURL: URL): ReactRuntimeURLs {
  const forModule = (filename: string) =>
    freshFrameAssetURL(new URL(filename, coreURL), "React runtime module");
  return Object.freeze({
    react: forModule("./react.mjs"),
    "react-dom": forModule("./react-dom.mjs"),
    "react-dom/client": forModule("./react-dom-client.mjs"),
    "react/jsx-runtime": forModule("./react-jsx-runtime.mjs"),
    "react/jsx-dev-runtime": forModule("./react-jsx-dev-runtime.mjs"),
  });
}

type FrameReply =
  | Readonly<{ kind: "ready" }>
  | Readonly<{ kind: "visible"; value: boolean }>
  | Readonly<{ kind: "styles-ready"; value: boolean }>
  | Readonly<{ kind: "styles-updated"; value: boolean }>
  | Readonly<{ kind: "error"; message: string }>;

type Deferred<T> = Readonly<{
  promise: Promise<T>;
  resolve: (value: T) => void;
}>;

type CandidateWaiter = Readonly<{
  ready: Deferred<FrameReply>;
  visible: Deferred<FrameReply>;
}>;

type StyleWaiter = Readonly<{
  revision: string;
  ready: Deferred<FrameReply>;
  updated: Deferred<FrameReply>;
}>;

type FrameSession = {
  generation: string;
  frame: HTMLIFrameElement;
  staging: HTMLDivElement;
  port: MessagePort | null;
  ready: Deferred<boolean>;
  resolveReady: ((ready: boolean) => void) | null;
};

export type BrowserPreviewOptions = Readonly<{
  wasmURL: string | URL;
  reactRuntimeURL: string | URL;
  onState?: (state: PreviewState) => void;
}>;

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function boundedMessageSize(value: Record<string, unknown>): number {
  const message = { ...value };
  const bytes = message.bytes;
  delete message.bytes;
  const envelope = encoder.encode(JSON.stringify(message)).byteLength;
  return envelope + (bytes instanceof ArrayBuffer ? bytes.byteLength : 0);
}

function postBounded(port: MessagePort, message: Record<string, unknown>): void {
  if (boundedMessageSize(message) > PREVIEW_LIMITS.messageBytes) {
    throw new Error(`Preview frame message exceeds ${PREVIEW_LIMITS.messageBytes} bytes`);
  }
  port.postMessage(message);
}

function capability(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function freshFrameAssetURL(value: string | URL, label: string): URL {
  const url = new URL(value, window.location.href);
  if (
    url.origin !== window.location.origin ||
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error(`${label} must be a credential-free asset on the preview host origin`);
  }
  return url;
}

export class IframePreviewTransport implements PreviewTransport {
  readonly #container: HTMLElement;
  readonly #reactRuntimeURLs: ReactRuntimeURLs;
  readonly #reactRuntimeURL: URL;
  #generation: string | null = null;
  #generationCapability = "";
  #latestCandidateId = 0;
  #visibleSession: FrameSession | null = null;
  #candidateSession: FrameSession | null = null;
  #activeCancellation: (() => void) | null = null;
  #waiters = new Map<number, CandidateWaiter>();
  #styleWaiters = new Map<number, StyleWaiter>();

  constructor(container: HTMLElement, reactRuntimeURL: string | URL) {
    this.#container = container;
    this.#reactRuntimeURL = freshFrameAssetURL(reactRuntimeURL, "React runtime");
    this.#reactRuntimeURLs = createReactRuntimeURLs(this.#reactRuntimeURL);
  }

  beginGeneration(generation: string): void {
    this.#cancelCandidate();
    this.#cancelStyleUpdates();
    this.#removeSession(this.#visibleSession);
    this.#visibleSession = null;
    this.#generation = generation;
    this.#generationCapability = capability();
    this.#latestCandidateId = 0;
  }

  requested(generation: string, candidateId: number): void {
    if (this.#generation !== generation) return;
    this.#latestCandidateId = candidateId;
    this.#cancelCandidate();
    const cancelStyles = this.#styleWaiters.size > 0;
    this.#cancelStyleUpdates();
    const port = this.#visibleSession?.port;
    if (cancelStyles && port !== null && port !== undefined) {
      postBounded(port, { type: "request", generation, candidateId });
    }
  }

  async publish(candidate: PreviewCandidate, isCurrent: () => boolean): Promise<boolean> {
    if (
      candidate.identity.generation !== this.#generation ||
      candidate.candidateId !== this.#latestCandidateId ||
      !isCurrent()
    ) {
      return false;
    }
    this.#cancelCandidate();

    let cancel!: () => void;
    const cancelled = new Promise<false>((resolve) => {
      cancel = () => resolve(false);
    });
    this.#activeCancellation = cancel;
    const session = this.#createCandidateSession(candidate.identity.generation);
    const completion = this.#publish(session, candidate, isCurrent, cancelled);
    try {
      return await completion;
    } finally {
      this.#waiters.delete(candidate.candidateId);
      if (this.#candidateSession === session) {
        this.#candidateSession = null;
        this.#removeSession(session);
      }
      if (this.#activeCancellation === cancel) this.#activeCancellation = null;
    }
  }

  async updateStyles(update: PreviewStyleUpdate, isCurrent: () => boolean): Promise<boolean> {
    const session = this.#visibleSession;
    const port = session?.port ?? null;
    if (
      session === null ||
      port === null ||
      session.generation !== update.identity.generation ||
      this.#generation !== update.identity.generation ||
      update.candidateId !== this.#latestCandidateId ||
      !isCurrent()
    ) {
      return false;
    }
    const css = encoder.encode(update.css);
    if (css.byteLength > PREVIEW_LIMITS.outputBytes) {
      throw new Error(`Compiled preview output exceeds ${PREVIEW_LIMITS.outputBytes} bytes`);
    }

    const waiter: StyleWaiter = {
      revision: update.identity.revision,
      ready: deferred<FrameReply>(),
      updated: deferred<FrameReply>(),
    };
    this.#styleWaiters.set(update.candidateId, waiter);
    try {
      postBounded(port, {
        type: "request",
        generation: update.identity.generation,
        candidateId: update.candidateId,
      });
      postBounded(port, {
        type: "styles-start",
        generation: update.identity.generation,
        candidateId: update.candidateId,
        revision: update.identity.revision,
        cssBytes: css.byteLength,
      });
      this.#postChunks(port, update, "css", css);
      postBounded(port, {
        type: "styles-finish",
        generation: update.identity.generation,
        candidateId: update.candidateId,
      });
      const ready = await waiter.ready.promise;
      if (ready.kind === "error") throw new Error(ready.message);
      if (
        ready.kind !== "styles-ready" ||
        !ready.value ||
        !isCurrent() ||
        this.#visibleSession !== session
      ) {
        return false;
      }
      postBounded(port, {
        type: "styles-commit",
        generation: update.identity.generation,
        candidateId: update.candidateId,
      });
      const reply = await waiter.updated.promise;
      if (reply.kind === "error") throw new Error(reply.message);
      return (
        reply.kind === "styles-updated" &&
        reply.value &&
        isCurrent() &&
        this.#visibleSession === session
      );
    } finally {
      if (this.#styleWaiters.get(update.candidateId) === waiter) {
        this.#styleWaiters.delete(update.candidateId);
      }
    }
  }

  dispose(): void {
    this.#cancelCandidate();
    this.#cancelStyleUpdates();
    this.#removeSession(this.#visibleSession);
    this.#visibleSession = null;
    this.#generation = null;
  }

  #cancelStyleUpdates(): void {
    for (const waiter of this.#styleWaiters.values()) {
      waiter.ready.resolve({ kind: "styles-ready", value: false });
      waiter.updated.resolve({ kind: "styles-updated", value: false });
    }
    this.#styleWaiters.clear();
  }
  #cancelCandidate(): void {
    this.#activeCancellation?.();
    this.#activeCancellation = null;
    const session = this.#candidateSession;
    this.#candidateSession = null;
    this.#removeSession(session);
  }

  #removeSession(session: FrameSession | null): void {
    if (session === null) return;
    session.resolveReady?.(false);
    session.resolveReady = null;
    session.port?.close();
    session.port = null;
    session.frame.remove();
    session.staging.remove();
  }

  #createCandidateSession(generation: string): FrameSession {
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.title = "StreamMDX project preview";
    frame.style.width = "100%";
    frame.style.minHeight = "280px";
    frame.style.height = "min(70vh, 720px)";
    frame.style.border = "0";
    frame.style.display = "block";

    const staging = document.createElement("div");
    staging.setAttribute("aria-hidden", "true");
    staging.style.position = "fixed";
    staging.style.left = "-10000px";
    staging.style.top = "0";
    staging.style.width = `${Math.max(this.#container.getBoundingClientRect().width, 320)}px`;
    staging.style.height = "600px";
    staging.style.overflow = "hidden";

    const session: FrameSession = {
      generation,
      frame,
      staging,
      port: null,
      ready: deferred<boolean>(),
      resolveReady: null,
    };
    session.resolveReady = session.ready.resolve;
    this.#candidateSession = session;
    frame.srcdoc = createFrameDocument({
      generation,
      capability: this.#generationCapability,
      nonce: capability(),
      reactRuntimeURL: this.#reactRuntimeURL,
      reactRuntimeURLs: this.#reactRuntimeURLs,
    });
    frame.addEventListener(
      "load",
      () => {
        if (this.#candidateSession !== session || this.#generation !== generation) return;
        const childWindow = frame.contentWindow;
        if (childWindow === null) {
          session.resolveReady?.(false);
          session.resolveReady = null;
          return;
        }
        const channel = new MessageChannel();
        session.port = channel.port1;
        channel.port1.onmessage = (event: MessageEvent<unknown>) => this.#receive(session, event.data);
        channel.port1.start();
        const init = { type: "init", generation, capability: this.#generationCapability };
        if (encoder.encode(JSON.stringify(init)).byteLength > PREVIEW_LIMITS.messageBytes) {
          this.#removeSession(session);
          return;
        }
        childWindow.postMessage(init, "*", [channel.port2]);
      },
      { once: true },
    );
    frame.addEventListener(
      "error",
      () => {
        if (this.#candidateSession === session) {
          session.resolveReady?.(false);
          session.resolveReady = null;
        }
      },
      { once: true },
    );
    staging.append(frame);
    this.#container.append(staging);
    return session;
  }

  async #publish(
    session: FrameSession,
    candidate: PreviewCandidate,
    isCurrent: () => boolean,
    cancelled: Promise<false>,
  ): Promise<boolean> {
    const frameReady = await Promise.race([session.ready.promise, cancelled]);
    if (
      !frameReady ||
      !isCurrent() ||
      this.#candidateSession !== session ||
      this.#generation !== candidate.identity.generation
    ) {
      return false;
    }
    const port = session.port;
    if (port === null) return false;

    const javascript = encoder.encode(candidate.javascript);
    const css = encoder.encode(candidate.css);
    if (javascript.byteLength + css.byteLength > PREVIEW_LIMITS.outputBytes) {
      throw new Error(`Compiled preview output exceeds ${PREVIEW_LIMITS.outputBytes} bytes`);
    }

    const waiter: CandidateWaiter = { ready: deferred<FrameReply>(), visible: deferred<FrameReply>() };
    this.#waiters.set(candidate.candidateId, waiter);
    try {
      postBounded(port, {
        type: "request",
        generation: candidate.identity.generation,
        candidateId: candidate.candidateId,
      });
      postBounded(port, {
        type: "start",
        generation: candidate.identity.generation,
        candidateId: candidate.candidateId,
        revision: candidate.identity.revision,
        javascriptBytes: javascript.byteLength,
        cssBytes: css.byteLength,
      });
      this.#postChunks(port, candidate, "javascript", javascript);
      this.#postChunks(port, candidate, "css", css);
      postBounded(port, {
        type: "finish",
        generation: candidate.identity.generation,
        candidateId: candidate.candidateId,
      });

      const staged = await Promise.race([waiter.ready.promise, cancelled]);
      if (staged === false) return false;
      if (staged.kind === "error") throw new Error(staged.message);
      if (staged.kind !== "ready") throw new Error("Unexpected preview frame reply while waiting for a candidate");
      if (!isCurrent() || this.#candidateSession !== session) {
        postBounded(port, {
          type: "discard",
          generation: candidate.identity.generation,
          candidateId: candidate.candidateId,
        });
        return false;
      }

      postBounded(port, {
        type: "commit",
        generation: candidate.identity.generation,
        candidateId: candidate.candidateId,
      });
      const visible = await Promise.race([waiter.visible.promise, cancelled]);
      if (visible === false) return false;
      if (visible.kind === "error") throw new Error(visible.message);
      if (visible.kind !== "visible") throw new Error("Unexpected preview frame reply while waiting for visibility");
      if (!visible.value || !isCurrent() || this.#candidateSession !== session) return false;
      this.#promoteSession(session);
      return true;
    } finally {
      this.#waiters.delete(candidate.candidateId);
    }
  }

  #postChunks(
    port: MessagePort,
    candidate: Pick<PreviewCandidate, "identity" | "candidateId"> | PreviewStyleUpdate,
    section: "javascript" | "css",
    bytes: Uint8Array,
  ): void {
    let index = 0;
    for (let offset = 0; offset < bytes.byteLength; offset += MAX_CHUNK_BYTES) {
      const length = Math.min(MAX_CHUNK_BYTES, bytes.byteLength - offset);
      const buffer = new ArrayBuffer(length);
      new Uint8Array(buffer).set(bytes.subarray(offset, offset + length));
      postBounded(port, {
        type: "chunk",
        generation: candidate.identity.generation,
        candidateId: candidate.candidateId,
        section,
        index,
        bytes: buffer,
      });
      index += 1;
    }
  }

  #promoteSession(session: FrameSession): void {
    const previous = this.#visibleSession;
    if (previous !== session) this.#removeSession(previous);
    for (const child of Array.from(this.#container.children)) {
      if (child !== session.staging) child.remove();
    }
    session.staging.removeAttribute("aria-hidden");
    session.staging.style.position = "relative";
    session.staging.style.left = "";
    session.staging.style.top = "";
    session.staging.style.width = "100%";
    session.staging.style.height = "auto";
    session.staging.style.overflow = "visible";
    session.frame.style.position = "";
    session.frame.style.left = "";
    session.frame.style.top = "";
    session.frame.style.width = "100%";
    session.frame.style.visibility = "visible";
    session.frame.removeAttribute("aria-hidden");
    this.#visibleSession = session;
    this.#candidateSession = null;
  }

  #receive(session: FrameSession, value: unknown): void {
    if (session !== this.#candidateSession && session !== this.#visibleSession) return;
    const message = objectRecord(value);
    if (message === null || boundedMessageSize(message) > PREVIEW_LIMITS.messageBytes) return;
    if (message.generation !== session.generation || typeof message.type !== "string") return;
    if (message.type === "ready") {
      session.resolveReady?.(true);
      session.resolveReady = null;
      return;
    }
    if (!Number.isSafeInteger(message.candidateId) || typeof message.revision !== "string") return;
    const candidateId = message.candidateId as number;
    const candidateWaiter = this.#waiters.get(candidateId);
    const styleWaiter = this.#styleWaiters.get(candidateId);

    if (message.type === "candidate-ready" && candidateWaiter !== undefined) {
      candidateWaiter.ready.resolve({ kind: "ready" });
      return;
    }
    if (message.type === "visible" && candidateWaiter !== undefined) {
      candidateWaiter.visible.resolve({ kind: "visible", value: true });
      return;
    }
    if (message.type === "discarded" && candidateWaiter !== undefined) {
      candidateWaiter.visible.resolve({ kind: "visible", value: false });
      return;
    }
    if (
      message.type === "styles-ready" &&
      styleWaiter !== undefined &&
      message.revision === styleWaiter.revision
    ) {
      styleWaiter.ready.resolve({ kind: "styles-ready", value: true });
      return;
    }
    if (
      message.type === "styles-updated" &&
      styleWaiter !== undefined &&
      message.revision === styleWaiter.revision
    ) {
      styleWaiter.updated.resolve({ kind: "styles-updated", value: true });
      return;
    }
    if (message.type === "error" && typeof message.message === "string") {
      const reply: FrameReply = { kind: "error", message: message.message.slice(0, 4 * 1024) };
      if (candidateWaiter !== undefined) {
        candidateWaiter.ready.resolve(reply);
        candidateWaiter.visible.resolve(reply);
      }
      if (styleWaiter !== undefined && message.revision === styleWaiter.revision) {
        styleWaiter.ready.resolve(reply);
        styleWaiter.updated.resolve(reply);
      }
      if (session === this.#candidateSession) this.#cancelCandidate();
    }
  }
}

export function createBrowserTransport(
  container: HTMLElement,
  reactRuntimeURL: string | URL,
): IframePreviewTransport {
  return new IframePreviewTransport(container, freshFrameAssetURL(reactRuntimeURL, "React runtime"));
}

export { freshFrameAssetURL };
