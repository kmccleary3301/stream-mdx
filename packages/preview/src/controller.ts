import { PREVIEW_LIMITS } from "./types";
import type {
  CompiledPreview,
  PreviewCandidate,
  PreviewClock,
  PreviewController,
  PreviewControllerOptions,
  PreviewError,
  PreviewIdentity,
  PreviewInput,
  PreviewState,
} from "./types";

const encoder = new TextEncoder();
const MAX_ERROR_MESSAGE = 4 * 1024;
const PUBLICATION_WINDOW_MS = 1000;

function publicationWait(now: number, publicationTimes: number[]): number {
  while (publicationTimes[0] !== undefined && publicationTimes[0] <= now - PUBLICATION_WINDOW_MS) {
    publicationTimes.shift();
  }
  if (publicationTimes.length < PREVIEW_LIMITS.publicationsPerSecond) return 0;
  return publicationTimes[0] + PUBLICATION_WINDOW_MS - now;
}
const EMPTY_STATE: PreviewState = Object.freeze({
  requested: null,
  compiled: null,
  candidateReady: null,
  visible: null,
  error: null,
});

function defaultClock(): PreviewClock {
  return {
    now: () => Date.now(),
    schedule(callback, delayMs) {
      const timer = setTimeout(callback, delayMs);
      return () => clearTimeout(timer);
    },
  };
}

function identityOf(input: PreviewInput): PreviewIdentity {
  return Object.freeze({ generation: input.generation, revision: input.revision });
}

function utf8Size(value: string): number {
  return encoder.encode(value).byteLength;
}

function validateProject(input: PreviewInput): PreviewInput {
  if (input.generation.length === 0 || input.revision.length === 0) {
    throw new Error("Preview generation and revision identities must not be empty");
  }
  if (input.files.size === 0 || input.files.size > PREVIEW_LIMITS.files) {
    throw new Error(`Preview projects must contain between 1 and ${PREVIEW_LIMITS.files} files`);
  }
  if (typeof input.entry !== "string" || input.entry.length === 0) {
    throw new Error("Preview entry must name a project file");
  }

  const files = new Map<string, string>();
  let inputBytes = 0;
  for (const [path, source] of input.files) {
    if (
      typeof path !== "string" ||
      path.length === 0 ||
      path.startsWith("/") ||
      path.includes("\\") ||
      path.includes("\0") ||
      path.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
    ) {
      throw new Error(`Unsafe preview project path: ${String(path)}`);
    }
    if (typeof source !== "string") throw new Error(`Preview source for ${path} must be a string`);
    inputBytes += utf8Size(path) + utf8Size(source);
    if (inputBytes > PREVIEW_LIMITS.inputBytes) {
      throw new Error(`Preview project input exceeds ${PREVIEW_LIMITS.inputBytes} bytes`);
    }
    files.set(path, source);
  }
  if (!files.has(input.entry)) throw new Error(`Preview entry ${input.entry} was not found in project files`);

  return Object.freeze({
    generation: input.generation,
    revision: input.revision,
    files,
    entry: input.entry,
  });
}

function compiledCandidate(
  identity: PreviewIdentity,
  candidateId: number,
  output: CompiledPreview,
): PreviewCandidate {
  if (typeof output.javascript !== "string") throw new Error("Preview compiler must return JavaScript source");
  const css = output.css ?? "";
  if (typeof css !== "string") throw new Error("Preview compiler CSS output must be a string");
  if (utf8Size(output.javascript) + utf8Size(css) > PREVIEW_LIMITS.outputBytes) {
    throw new Error(`Compiled preview output exceeds ${PREVIEW_LIMITS.outputBytes} bytes`);
  }
  return Object.freeze({ identity, candidateId, javascript: output.javascript, css });
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, MAX_ERROR_MESSAGE);
}

export function createPreviewController(options: PreviewControllerOptions): PreviewController {
  const clock = options.clock ?? defaultClock();
  let state = EMPTY_STATE;
  let generation: string | null = null;
  let nextCandidateId = 0;
  let activeCompilation = false;
  let pendingCompilation: {
    candidateId: number;
    identity: PreviewIdentity;
    input: PreviewInput;
    resolve: () => void;
  } | null = null;
  let readyCandidate: PreviewCandidate | null = null;
  let publicationTimer: (() => void) | null = null;
  let publishing = false;
  const publicationTimes: number[] = [];
  let disposed = false;

  function updateState(patch: Partial<PreviewState>): void {
    if (disposed) return;
    state = Object.freeze({ ...state, ...patch });
    options.onState?.(state);
  }

  function isCurrent(candidateId: number, identity: PreviewIdentity): boolean {
    return (
      !disposed &&
      generation === identity.generation &&
      state.requested?.generation === identity.generation &&
      state.requested.revision === identity.revision &&
      nextCandidateId === candidateId
    );
  }

  function cancelPublicationTimer(): void {
    publicationTimer?.();
    publicationTimer = null;
  }

  function schedulePublication(): void {
    if (disposed || publishing || readyCandidate === null || publicationTimer !== null) return;
    const waitMs = publicationWait(clock.now(), publicationTimes);
    if (waitMs > 0) {
      publicationTimer = clock.schedule(() => {
        publicationTimer = null;
        void publishReadyCandidate();
      }, waitMs);
      return;
    }
    void publishReadyCandidate();
  }

  async function publishReadyCandidate(): Promise<void> {
    if (disposed || publishing || readyCandidate === null) return;
    const candidate = readyCandidate;
    if (!isCurrent(candidate.candidateId, candidate.identity)) return;

    const waitMs = publicationWait(clock.now(), publicationTimes);
    if (waitMs > 0) {
      schedulePublication();
      return;
    }

    publishing = true;
    try {
      const published = await options.transport.publish(candidate, () =>
        isCurrent(candidate.candidateId, candidate.identity),
      );
      if (published) publicationTimes.push(clock.now());
      if (!isCurrent(candidate.candidateId, candidate.identity)) return;
      readyCandidate = null;
      if (published) {
        updateState({ visible: candidate.identity, candidateReady: null, error: null });
      } else {
        const failure: PreviewError = Object.freeze({
          identity: candidate.identity,
          message: "Preview candidate did not become visible",
        });
        updateState({ candidateReady: null, error: failure });
      }
    } catch (error) {
      if (isCurrent(candidate.candidateId, candidate.identity)) {
        readyCandidate = null;
        const failure: PreviewError = Object.freeze({
          identity: candidate.identity,
          message: errorMessage(error),
        });
        updateState({ candidateReady: null, error: failure });
      }
    } finally {
      publishing = false;
      schedulePublication();
    }
  }

  async function compilePending(): Promise<void> {
    if (activeCompilation || disposed) return;
    activeCompilation = true;
    try {
      while (pendingCompilation !== null && !disposed) {
        const work = pendingCompilation;
        pendingCompilation = null;
        try {
          if (!isCurrent(work.candidateId, work.identity)) continue;
          const output = await options.compile(work.input, {
            isCurrent: () => isCurrent(work.candidateId, work.identity),
          });
          if (!isCurrent(work.candidateId, work.identity)) continue;
          const candidate = compiledCandidate(work.identity, work.candidateId, output);
          if (!isCurrent(work.candidateId, work.identity)) continue;
          readyCandidate = candidate;
          updateState({ compiled: work.identity, candidateReady: work.identity, error: null });
          schedulePublication();
        } catch (error) {
          if (isCurrent(work.candidateId, work.identity)) {
            readyCandidate = null;
            const failure: PreviewError = Object.freeze({
              identity: work.identity,
              message: errorMessage(error),
            });
            updateState({ candidateReady: null, error: failure });
          }
        } finally {
          work.resolve();
        }
      }
    } finally {
      activeCompilation = false;
      if (pendingCompilation !== null && !disposed) void compilePending();
    }
  }

  function request(input: PreviewInput): Promise<void> {
    if (disposed) return Promise.resolve();

    const identity = identityOf(input);
    const candidateId = ++nextCandidateId;
    if (generation !== input.generation) {
      generation = input.generation;
      pendingCompilation?.resolve();
      pendingCompilation = null;
      readyCandidate = null;
      cancelPublicationTimer();
      options.transport.beginGeneration(input.generation);
      updateState({ requested: null, compiled: null, candidateReady: null, visible: null, error: null });
    }

    pendingCompilation?.resolve();
    pendingCompilation = null;
    readyCandidate = null;
    cancelPublicationTimer();
    updateState({ requested: identity, candidateReady: null, error: null });
    options.transport.requested(input.generation, candidateId);

    let normalized: PreviewInput;
    try {
      normalized = validateProject(input);
    } catch (error) {
      const failure: PreviewError = Object.freeze({ identity, message: errorMessage(error) });
      updateState({ error: failure });
      return Promise.resolve();
    }

    let resolve!: () => void;
    const completion = new Promise<void>((fulfill) => {
      resolve = fulfill;
    });
    pendingCompilation = { candidateId, identity, input: normalized, resolve };
    void compilePending();
    return completion;
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    nextCandidateId += 1;
    pendingCompilation?.resolve();
    pendingCompilation = null;
    readyCandidate = null;
    cancelPublicationTimer();
    options.transport.dispose();
  }

  return {
    request,
    getState: () => state,
    dispose,
  };
}
