import React, { useCallback, useState } from "react";
import type { InlineNode } from "@stream-mdx/core";
import type {
  ControlsConfig,
  ControlsLabels,
  TableCopyFormat,
  TableDownloadFormat,
} from "../types";

export const DEFAULT_CONTROLS_LABELS: ControlsLabels = {
  copy: "Copy code",
  copied: "Copied!",
  copyError: "Failed to copy",
  download: "Download snippet",
  downloadCsv: "Download CSV",
  downloadTsv: "Download TSV",
  downloadMarkdown: "Download Markdown",
  copyTsv: "Copy TSV",
  copyMarkdown: "Copy Markdown",
  copyTable: "Copy table",
  fullscreen: "Enter fullscreen",
  exitFullscreen: "Exit fullscreen",
};

export const LANGUAGE_EXTENSION_MAP: Record<string, string> = {
  javascript: "js",
  js: "js",
  mjs: "mjs",
  cjs: "cjs",
  typescript: "ts",
  ts: "ts",
  mts: "mts",
  cts: "cts",
  jsx: "jsx",
  tsx: "tsx",
  python: "py",
  py: "py",
  rust: "rs",
  rs: "rs",
  ruby: "rb",
  rb: "rb",
  go: "go",
  golang: "go",
  c: "c",
  cpp: "cpp",
  "c++": "cpp",
  csharp: "cs",
  "c#": "cs",
  cs: "cs",
  java: "java",
  kotlin: "kt",
  kt: "kt",
  swift: "swift",
  php: "php",
  html: "html",
  css: "css",
  scss: "scss",
  sass: "sass",
  less: "less",
  json: "json",
  jsonc: "jsonc",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  xml: "xml",
  svg: "svg",
  markdown: "md",
  md: "md",
  mdx: "mdx",
  sh: "sh",
  bash: "sh",
  shell: "sh",
  zsh: "sh",
  sql: "sql",
  diff: "diff",
  dockerfile: "dockerfile",
  makefile: "makefile",
  graphql: "graphql",
  gql: "graphql",
  lua: "lua",
  r: "r",
  scala: "scala",
  perl: "pl",
  pl: "pl",
  mermaid: "mmd",
  latex: "tex",
  tex: "tex",
  ini: "ini",
  env: "env",
  text: "txt",
  txt: "txt",
};

export function getExtensionForLanguage(lang?: string): string {
  if (!lang) return "txt";
  const clean = lang.trim().toLowerCase().split(/\s+/)[0] ?? "";
  if (!clean) return "txt";
  if (LANGUAGE_EXTENSION_MAP[clean]) {
    return LANGUAGE_EXTENSION_MAP[clean];
  }
  if (/^[a-z0-9]+$/.test(clean)) {
    return clean;
  }
  return "txt";
}

export function getCodeSnippetFilename(lang?: string): string {
  const ext = getExtensionForLanguage(lang);
  return `snippet.${ext}`;
}

export async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
    return false;
  }
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function downloadFile(content: string, filename: string, mimeType = "text/plain;charset=utf-8"): void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return;
  }
  try {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    try {
      a.click();
    } finally {
      document.body.removeChild(a);
      setTimeout(() => {
        try {
          URL.revokeObjectURL(url);
        } catch {
          // Ignore revocation errors
        }
      }, 100);
    }
  } catch {
    // Failure handling (no throw)
  }
}

export function escapeCsvCell(cell: string): string {
  if (/[",\r\n]/.test(cell)) {
    return `"${cell.replace(/"/g, '""')}"`;
  }
  return cell;
}

export function escapeTsvCell(cell: string): string {
  return cell.replace(/\t/g, " ").replace(/\r?\n/g, " ");
}

export function tableToCsv(headers: string[], rows: string[][]): string {
  const lines: string[] = [];
  if (headers.length > 0) {
    lines.push(headers.map(escapeCsvCell).join(","));
  }
  for (const row of rows) {
    lines.push(row.map(escapeCsvCell).join(","));
  }
  return lines.join("\n");
}

export function tableToTsv(headers: string[], rows: string[][]): string {
  const lines: string[] = [];
  if (headers.length > 0) {
    lines.push(headers.map(escapeTsvCell).join("\t"));
  }
  for (const row of rows) {
    lines.push(row.map(escapeTsvCell).join("\t"));
  }
  return lines.join("\n");
}

export function tableToMarkdown(
  headers: string[],
  rows: string[][],
  align?: Array<"left" | "center" | "right" | null>,
): string {
  if (headers.length === 0 && rows.length === 0) return "";
  const columnCount = Math.max(headers.length, ...rows.map((r) => r.length));
  if (columnCount === 0) return "";

  const padRow = (row: string[]): string[] => {
    const padded = [...row];
    while (padded.length < columnCount) padded.push("");
    return padded.map((cell) => cell.replace(/\r?\n/g, " ").replace(/\|/g, "\\|"));
  };

  const formattedHeaders = padRow(headers.length > 0 ? headers : Array(columnCount).fill(""));
  const headerLine = `| ${formattedHeaders.join(" | ")} |`;

  const separatorLine = `| ${Array.from({ length: columnCount }, (_, i) => {
    const a = align?.[i];
    if (a === "center") return ":---:";
    if (a === "right") return "---:";
    if (a === "left") return ":---";
    return "---";
  }).join(" | ")} |`;

  const dataLines = rows.map((row) => `| ${padRow(row).join(" | ")} |`);

  return [headerLine, separatorLine, ...dataLines].join("\n");
}

export function inlineToPlainText(nodes?: InlineNode[]): string {
  if (!Array.isArray(nodes) || nodes.length === 0) return "";
  let out = "";
  for (const node of nodes) {
    if (!node) continue;
    switch (node.kind) {
      case "text":
      case "code":
        out += node.text ?? "";
        break;
      case "strong":
      case "em":
      case "strike":
        out += inlineToPlainText(node.children);
        break;
      case "link":
        out += inlineToPlainText(node.children) || node.title || node.href || "";
        break;
      case "image":
        out += node.alt || node.title || "";
        break;
      case "br":
        out += "\n";
        break;
      case "html":
        if (Array.isArray(node.children) && node.children.length > 0) {
          out += inlineToPlainText(node.children);
        } else if (node.raw) {
          if (/<br\s*\/?>/i.test(node.raw)) {
            out += "\n";
          } else {
            out += node.raw.replace(/<[^>]*>/g, "");
          }
        }
        break;
      case "math-inline":
      case "math-display":
        out += node.tex ?? "";
        break;
      case "mention":
        out += `@${node.handle ?? ""}`;
        break;
      case "citation":
        out += `[${node.id ?? ""}]`;
        break;
      case "footnote-ref":
        out += `[${node.label ?? ""}]`;
        break;
      case "plugin":
        if (Array.isArray(node.children)) {
          out += inlineToPlainText(node.children);
        } else {
          out += node.raw ?? "";
        }
        break;
      default: {
        const generic: unknown = node;
        if (generic && typeof generic === "object") {
          if ("text" in generic && typeof generic.text === "string") {
            out += generic.text;
          } else if ("children" in generic && Array.isArray(generic.children)) {
            out += inlineToPlainText(generic.children as InlineNode[]);
          }
        }
        break;
      }
    }
  }
  return out;
}

export interface ResolvedCodeControls {
  enabled: boolean;
  copy: boolean;
  download: boolean;
  labels: ControlsLabels;
}

export function resolveCodeControls(config?: ControlsConfig): ResolvedCodeControls {
  if (!config) {
    return { enabled: false, copy: false, download: false, labels: DEFAULT_CONTROLS_LABELS };
  }
  const labels: ControlsLabels = {
    ...DEFAULT_CONTROLS_LABELS,
    ...(typeof config === "object" ? config.labels : undefined),
  };
  if (config === true) {
    return { enabled: true, copy: true, download: true, labels };
  }
  const codeOpt = config.code;
  if (!codeOpt) {
    return { enabled: false, copy: false, download: false, labels };
  }
  if (codeOpt === true) {
    return { enabled: true, copy: true, download: true, labels };
  }
  const copy = Boolean(codeOpt.copy);
  const download = Boolean(codeOpt.download);
  return { enabled: copy || download, copy, download, labels };
}

export interface ResolvedTableControls {
  enabled: boolean;
  copy: boolean;
  copyFormats: TableCopyFormat[];
  download: boolean;
  downloadFormats: TableDownloadFormat[];
  labels: ControlsLabels;
}

export function resolveTableControls(config?: ControlsConfig): ResolvedTableControls {
  if (!config) {
    return {
      enabled: false,
      copy: false,
      copyFormats: [],
      download: false,
      downloadFormats: [],
      labels: DEFAULT_CONTROLS_LABELS,
    };
  }
  const labels: ControlsLabels = {
    ...DEFAULT_CONTROLS_LABELS,
    ...(typeof config === "object" ? config.labels : undefined),
  };
  if (config === true) {
    return {
      enabled: true,
      copy: true,
      copyFormats: ["tsv", "markdown"],
      download: true,
      downloadFormats: ["csv"],
      labels,
    };
  }
  const tableOpt = config.table;
  if (!tableOpt) {
    return {
      enabled: false,
      copy: false,
      copyFormats: [],
      download: false,
      downloadFormats: [],
      labels: DEFAULT_CONTROLS_LABELS,
    };
  }
  if (tableOpt === true) {
    return {
      enabled: true,
      copy: true,
      copyFormats: ["tsv", "markdown"],
      download: true,
      downloadFormats: ["csv"],
      labels,
    };
  }
  const copyVal = tableOpt.copy;
  const copy = Boolean(copyVal);
  const copyFormats: TableCopyFormat[] = Array.isArray(copyVal) ? copyVal : copyVal ? ["tsv", "markdown"] : [];

  const downloadVal = tableOpt.download;
  const download = Boolean(downloadVal);
  const downloadFormats: TableDownloadFormat[] = Array.isArray(downloadVal)
    ? downloadVal
    : downloadVal
      ? ["csv"]
      : [];

  return {
    enabled: copy || download,
    copy,
    copyFormats,
    download,
    downloadFormats,
    labels,
  };
}

export interface ResolvedMermaidControls {
  enabled: boolean;
  copy: boolean;
  fullscreen: boolean;
  labels: ControlsLabels;
}

export function resolveMermaidControls(config?: ControlsConfig): ResolvedMermaidControls {
  if (!config) {
    return { enabled: false, copy: false, fullscreen: false, labels: DEFAULT_CONTROLS_LABELS };
  }
  const labels: ControlsLabels = {
    ...DEFAULT_CONTROLS_LABELS,
    ...(typeof config === "object" ? config.labels : undefined),
  };
  if (config === true) {
    return { enabled: true, copy: true, fullscreen: false, labels };
  }
  const mermaidOpt = config.mermaid;
  if (!mermaidOpt) {
    return { enabled: false, copy: false, fullscreen: false, labels };
  }
  if (mermaidOpt === true) {
    return { enabled: true, copy: true, fullscreen: false, labels };
  }
  const copy = Boolean(mermaidOpt.copy);
  const fullscreen = Boolean(mermaidOpt.fullscreen);
  return { enabled: copy || fullscreen, copy, fullscreen, labels };
}

export function resolveControlsConfig(config?: ControlsConfig): {
  code: ResolvedCodeControls;
  table: ResolvedTableControls;
  mermaid: ResolvedMermaidControls;
} {
  return {
    code: resolveCodeControls(config),
    table: resolveTableControls(config),
    mermaid: resolveMermaidControls(config),
  };
}

export interface CodeControlsBarProps {
  code: string;
  language?: string;
  config: ResolvedCodeControls;
  className?: string;
}

export const CodeControlsBar: React.FC<CodeControlsBarProps> = ({ code, language, config, className }) => {
  const [copied, setCopied] = useState(false);
  const { labels } = config;

  const handleCopy = useCallback(async () => {
    const success = await copyToClipboard(code);
    if (success) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [code]);

  const handleDownload = useCallback(() => {
    const filename = getCodeSnippetFilename(language);
    downloadFile(code, filename);
  }, [code, language]);

  return (
    <div
      className={`stream-mdx-controls stream-mdx-code-controls flex items-center justify-end gap-1 px-2 py-1 text-xs select-none ${className ?? ""}`.trim()}
      data-stream-mdx-controls="code"
    >
      {language ? (
        <span className="stream-mdx-code-language mr-auto text-muted-foreground opacity-60 text-[11px] font-mono">
          {language}
        </span>
      ) : null}
      {config.copy ? (
        <button
          type="button"
          className="stream-mdx-control stream-mdx-control-copy stream-mdx-control-code-copy inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs hover:bg-muted focus:outline-none"
          data-stream-mdx-control="copy"
          data-stream-mdx-target="code"
          data-stream-mdx-action="copy"
          aria-label={copied ? (labels.copied ?? "Copied!") : (labels.copy ?? "Copy code")}
          onClick={handleCopy}
        >
          {copied ? (labels.copied ?? "Copied!") : (labels.copy ?? "Copy")}
        </button>
      ) : null}
      {config.download ? (
        <button
          type="button"
          className="stream-mdx-control stream-mdx-control-download stream-mdx-control-code-download inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs hover:bg-muted focus:outline-none"
          data-stream-mdx-control="download"
          data-stream-mdx-target="code"
          data-stream-mdx-action="download"
          aria-label={labels.download ?? "Download snippet"}
          onClick={handleDownload}
        >
          {labels.download ?? "Download"}
        </button>
      ) : null}
    </div>
  );
};

export interface TableControlsBarProps {
  headers: string[];
  rows: string[][];
  align?: Array<"left" | "center" | "right" | null>;
  isFinalized: boolean;
  config: ResolvedTableControls;
  className?: string;
}

export const TableControlsBar: React.FC<TableControlsBarProps> = ({
  headers,
  rows,
  align,
  isFinalized,
  config,
  className,
}) => {
  const [copiedFormat, setCopiedFormat] = useState<string | null>(null);
  const { labels } = config;

  const handleCopy = useCallback(
    async (format: TableCopyFormat) => {
      if (!isFinalized) return;
      const text = format === "markdown" ? tableToMarkdown(headers, rows, align) : tableToTsv(headers, rows);
      const success = await copyToClipboard(text);
      if (success) {
        setCopiedFormat(format);
        setTimeout(() => setCopiedFormat(null), 2000);
      }
    },
    [headers, rows, align, isFinalized],
  );

  const handleDownload = useCallback(
    (format: TableDownloadFormat) => {
      if (!isFinalized) return;
      let text = "";
      let filename = "table.csv";
      let mimeType = "text/csv;charset=utf-8";
      if (format === "tsv") {
        text = tableToTsv(headers, rows);
        filename = "table.tsv";
        mimeType = "text/tab-separated-values;charset=utf-8";
      } else if (format === "markdown") {
        text = tableToMarkdown(headers, rows, align);
        filename = "table.md";
        mimeType = "text/markdown;charset=utf-8";
      } else {
        text = tableToCsv(headers, rows);
        filename = "table.csv";
        mimeType = "text/csv;charset=utf-8";
      }
      downloadFile(text, filename, mimeType);
    },
    [headers, rows, align, isFinalized],
  );

  return (
    <div
      className={`stream-mdx-controls stream-mdx-table-controls flex items-center justify-end gap-1 px-2 py-1 text-xs select-none ${className ?? ""}`.trim()}
      data-stream-mdx-controls="table"
    >
      {config.copyFormats.map((format) => {
        const isCopied = copiedFormat === format;
        const defaultLabel = format === "markdown" ? "Copy Markdown" : "Copy TSV";
        const labelText =
          format === "markdown"
            ? (labels.copyMarkdown ?? defaultLabel)
            : (labels.copyTsv ?? defaultLabel);
        return (
          <button
            key={`copy-${format}`}
            type="button"
            disabled={!isFinalized}
            className={`stream-mdx-control stream-mdx-control-copy stream-mdx-control-table-copy stream-mdx-control-copy-${format} inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs hover:bg-muted focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed`}
            data-stream-mdx-control="copy"
            data-stream-mdx-target="table"
            data-stream-mdx-format={format}
            data-stream-mdx-action={`copy-${format}`}
            data-format={format}
            aria-label={isCopied ? (labels.copied ?? "Copied!") : labelText}
            onClick={() => handleCopy(format)}
          >
            {isCopied ? (labels.copied ?? "Copied!") : labelText}
          </button>
        );
      })}
      {config.downloadFormats.map((format) => {
        const defaultLabel =
          format === "csv"
            ? "Download CSV"
            : format === "tsv"
              ? "Download TSV"
              : "Download Markdown";
        const labelText =
          format === "csv"
            ? (labels.downloadCsv ?? defaultLabel)
            : format === "tsv"
              ? (labels.downloadTsv ?? defaultLabel)
              : (labels.downloadMarkdown ?? defaultLabel);
        return (
          <button
            key={`download-${format}`}
            type="button"
            disabled={!isFinalized}
            className={`stream-mdx-control stream-mdx-control-download stream-mdx-control-table-download stream-mdx-control-download-${format} inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs hover:bg-muted focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed`}
            data-stream-mdx-control="download"
            data-stream-mdx-target="table"
            data-stream-mdx-format={format}
            data-stream-mdx-action={`download-${format}`}
            data-format={format}
            aria-label={labelText}
            onClick={() => handleDownload(format)}
          >
            {labelText}
          </button>
        );
      })}
    </div>
  );
};

export interface CodeBlockCopyButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  code: string;
  labels?: ControlsLabels;
}

export const CodeBlockCopyButton: React.FC<CodeBlockCopyButtonProps> = ({
  code,
  labels,
  className,
  ...props
}) => {
  const [copied, setCopied] = useState(false);
  const copyLabel = labels?.copy ?? DEFAULT_CONTROLS_LABELS.copy ?? "Copy code";
  const copiedLabel = labels?.copied ?? DEFAULT_CONTROLS_LABELS.copied ?? "Copied!";

  const handleCopy = useCallback(
    async (e: React.MouseEvent<HTMLButtonElement>) => {
      props.onClick?.(e);
      if (e.defaultPrevented) return;
      const success = await copyToClipboard(code);
      if (success) {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }
    },
    [code, props.onClick],
  );

  return (
    <button
      type="button"
      className={`stream-mdx-control stream-mdx-control-copy stream-mdx-control-code-copy ${className ?? ""}`.trim()}
      data-stream-mdx-control="copy"
      data-stream-mdx-target="code"
      data-stream-mdx-action="copy"
      aria-label={copied ? copiedLabel : copyLabel}
      {...props}
      onClick={handleCopy}
    >
      {props.children ?? (copied ? copiedLabel : "Copy")}
    </button>
  );
};

export interface CodeBlockDownloadButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  code: string;
  language?: string;
  filename?: string;
  labels?: ControlsLabels;
}

export const CodeBlockDownloadButton: React.FC<CodeBlockDownloadButtonProps> = ({
  code,
  language,
  filename,
  labels,
  className,
  ...props
}) => {
  const downloadLabel = labels?.download ?? DEFAULT_CONTROLS_LABELS.download ?? "Download snippet";

  const handleDownload = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      props.onClick?.(e);
      if (e.defaultPrevented) return;
      const targetFilename = filename ?? getCodeSnippetFilename(language);
      downloadFile(code, targetFilename);
    },
    [code, language, filename, props.onClick],
  );

  return (
    <button
      type="button"
      className={`stream-mdx-control stream-mdx-control-download stream-mdx-control-code-download ${className ?? ""}`.trim()}
      data-stream-mdx-control="download"
      data-stream-mdx-target="code"
      data-stream-mdx-action="download"
      aria-label={downloadLabel}
      {...props}
      onClick={handleDownload}
    >
      {props.children ?? (labels?.download ?? "Download")}
    </button>
  );
};
