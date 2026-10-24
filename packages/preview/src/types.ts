export const PREVIEW_LIMITS = Object.freeze({
  files: 128,
  inputBytes: 2 * 1024 * 1024,
  outputBytes: 16 * 1024 * 1024,
  messageBytes: 64 * 1024,
  publicationsPerSecond: 4,
  variants: 4,
});

export type PreviewIdentity = Readonly<{
  generation: string;
  revision: string;
}>;

export type PreviewInput = Readonly<{
  generation: string;
  revision: string;
  files: ReadonlyMap<string, string>;
  entry: string;
}>;

export type TailwindStylesheetName = "index.css" | "theme.css" | "preflight.css" | "utilities.css";
export type TailwindStylesheetLoader = (
  name: TailwindStylesheetName,
  context: PreviewCompileContext,
) => Promise<string>;
export type CompiledPreview = Readonly<{
  javascript: string;
  css?: string;
}>;

export type PreviewCandidate = Readonly<{
  identity: PreviewIdentity;
  candidateId: number;
  javascript: string;
  css: string;
}>;

export type PreviewStyleUpdate = Readonly<{
  identity: PreviewIdentity;
  candidateId: number;
  css: string;
}>;

export type PreviewStyleResult = Readonly<{
  kind: "styles-updated";
  identity: PreviewIdentity;
}>;

export type PreviewError = Readonly<{
  identity: PreviewIdentity;
  message: string;
}>;

export type PreviewState = Readonly<{
  requested: PreviewIdentity | null;
  compiled: PreviewIdentity | null;
  candidateReady: PreviewIdentity | null;
  visible: PreviewIdentity | null;
  styleResult: PreviewStyleResult | null;
  error: PreviewError | null;
}>;

export type PreviewCompileContext = Readonly<{ isCurrent: () => boolean }>;
export type PreviewCompiler = (input: PreviewInput, context: PreviewCompileContext) => Promise<CompiledPreview>;

export interface PreviewTransport {
  beginGeneration(generation: string): void;
  requested(generation: string, candidateId: number): void;
  publish(candidate: PreviewCandidate, isCurrent: () => boolean): Promise<boolean>;
  updateStyles(update: PreviewStyleUpdate, isCurrent: () => boolean): Promise<boolean>;
  dispose(): void;
}

export interface PreviewClock {
  now(): number;
  schedule(callback: () => void, delayMs: number): () => void;
}

export type PreviewControllerOptions = Readonly<{
  compile: PreviewCompiler;
  transport: PreviewTransport;
  onState?: (state: PreviewState) => void;
  clock?: PreviewClock;
}>;

export interface PreviewController {
  request(input: PreviewInput): Promise<void>;
  getState(): PreviewState;
  dispose(): void;
}
