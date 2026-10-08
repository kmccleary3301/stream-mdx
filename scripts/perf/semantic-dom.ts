export type SemanticDomRecords = {
  text: string;
  codeBlocks: Array<{ language: string; code: string }>;
  inlineCode: string[];
  preformatted: string[];
  inlineOrder: Array<{ kind: "text"; text: string } | { kind: "open" | "close"; tag: string; attributes: Array<[string, string]> }>;
  headings: Array<{ level: number; text: string }>;
  math: Array<{ display: boolean; tex: string }>;
  tables: Array<{ rows: Array<{ section: string; cells: Array<{ header: boolean; colspan: number; rowspan: number; align: string; text: string }> }> }>;
  lists: Array<{ depth: number; ordered: boolean; start: number | null; reversed: boolean; markerType: string; items: Array<{ value: number | null; checked: boolean | null; text: string }> }>;
  links: Array<{ url: string; title: string; text: string }>;
  html: Array<{ tag: string; attributes: Array<[string, string]>; text: string }>;
};

const CONTROL_SELECTOR = "[data-control],script,style,[data-streamdown='code-block-header'],[data-streamdown='code-block-actions'],[data-streamdown$='-button'],.katex-mathml";
const BLOCK_TAGS: Record<string, true> = { P: true, DIV: true, SECTION: true, ARTICLE: true, ASIDE: true, BLOCKQUOTE: true, H1: true, H2: true, H3: true, H4: true, H5: true, H6: true, LI: true, TR: true, SUMMARY: true, DETAILS: true };

export type GeneratedFootnoteLabel = { level: number; text: string; html: string };

function isGeneratedFootnoteLabel(element: Element): boolean {
  return element.matches("h2.sr-only#footnote-label") &&
    element.parentElement?.matches("section[data-footnotes]") === true;
}

export function collectGeneratedFootnoteLabels(root: HTMLElement): GeneratedFootnoteLabel[] {
  return Array.from(root.querySelectorAll("h2")).filter(isGeneratedFootnoteLabel)
    .map((element) => ({ level: 2, text: element.textContent ?? "", html: element.outerHTML }));
}

export function renderedCodeSource(body: Element): string {
  // Streamdown uses block spans and a newline placeholder for an empty source line.
  if (body.closest('[data-streamdown="code-block"]')) {
    return Array.from(body.children, (line) => {
      const text = line.textContent ?? "";
      return text === "\n" ? "" : text;
    }).join("\n");
  }
  return body.textContent ?? "";
}

export function collectSemanticDom(root: HTMLElement): SemanticDomRecords {
  const codeBodies = Array.from(root.querySelectorAll("pre code"));
  const preformatted = Array.from(root.querySelectorAll<Element>("pre")).filter((element) => {
    if (element.closest(CONTROL_SELECTOR)) return false;
    const code = element.querySelector("code");
    if (!code) return true;
    // Renderer-owned fences replace their whole wrapper with the code source.
    // Authored PRE siblings, including whitespace, are visible source too.
    return !element.closest(".markdown-code-block,[data-streamdown='code-block']") &&
      (element.childNodes.length !== 1 || element.firstChild !== code);
  });
  const outerCode = new Map<Element, { body: Element; index: number }>();
  for (const body of codeBodies) {
    const pre = body.closest("pre");
    if (!pre || preformatted.includes(pre)) continue;
    const wrapper = body.closest(".markdown-code-block,[data-streamdown='code-block']") ?? pre;
    outerCode.set(wrapper, { body, index: codeBodies.indexOf(body) });
  }

  const mathRoots = Array.from(root.querySelectorAll(".katex"));
  const inlineCode = Array.from(root.querySelectorAll<Element>("code")).filter((element) => !element.closest("pre"));
  const mathSource = (element: Element): string => element.querySelector("annotation[encoding='application/x-tex']")?.textContent ?? element.closest("[data-tex]")?.getAttribute("data-tex") ?? "";
  const textOf = (node: Node): string => {
    if (node.nodeType === 3) return (node.textContent ?? "").replace(/\s+/g, " ");
    if (node.nodeType !== 1) return "";
    // nodeType establishes the DOM Element boundary in both browsers and jsdom.
    const element = node as Element;
    if (element.matches(CONTROL_SELECTOR)) return "";
    if (isGeneratedFootnoteLabel(element)) return "";
    const body = outerCode.get(element);
    if (body) return `\n\n\uFFF0${body.index}\uFFF1\n\n`;
    if (element.tagName === "CODE" && !element.closest("pre")) return `\uFFF2${inlineCode.indexOf(element)}\uFFF3`;
    if (element.tagName === "PRE") return `\n\n\uFFF4${preformatted.indexOf(element)}\uFFF5\n\n`;
    if (element.matches(".katex")) return ` ${mathSource(element)} `;
    if (element.tagName === "BR") return "\n";
    if (element.tagName === "HR") return "\n";
    const content = Array.from(element.childNodes, textOf).join("");
    if (element.tagName === "TD" || element.tagName === "TH") return `${content}\t`;
    return BLOCK_TAGS[element.tagName] ? `\n${content}\n` : content;
  };
  const normalizeText = (text: string): string => text.replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  const contentOf = (element: Element): string => normalizeText(textOf(element))
    .replace(/\uFFF0(\d+)\uFFF1/g, (_, index: string) => renderedCodeSource(codeBodies[Number(index)]))
    .replace(/\uFFF2(\d+)\uFFF3/g, (_, index: string) => inlineCode[Number(index)].textContent ?? "")
    .replace(/\uFFF4(\d+)\uFFF5/g, (_, index: string) => preformatted[Number(index)].textContent ?? "");
  const outsideCode = (element: Element): boolean => !element.closest("pre,.markdown-code-block,[data-streamdown='code-block']") && !element.closest(CONTROL_SELECTOR) && !isGeneratedFootnoteLabel(element);

  const semanticTag = (element: Element): string => element.matches('[data-streamdown="strong"]') ? "strong" : element.tagName.toLowerCase();
  const semanticAttributes = (element: Element): Array<[string, string]> => Array.from(element.attributes)
    .filter((attribute) => /^(href|src|alt|title|open|datetime|cite|lang|dir|role|aria-)/.test(attribute.name))
    .map((attribute): [string, string] => [attribute.name, attribute.value])
    .sort(([left], [right]) => left.localeCompare(right));
  const semanticHtml = (element: Element): boolean => element.matches("details,summary,abbr,mark,time,img,video,audio,iframe,blockquote,hr,strong,em,b,u,s,button,del,ins,kbd,sup,sub,[data-streamdown='strong']") ||
    semanticAttributes(element).some(([name]) => /^(alt|title|open|datetime|cite|lang|dir|role|aria-)/.test(name));
  // Enter/exit events associate repeated text with its inline semantics. Plain
  // styling spans contribute text but no events, including Shiki token wrappers.
  const inlineOrder: SemanticDomRecords["inlineOrder"] = [];
  let plainText = "";
  const flushText = (): void => {
    const text = normalizeText(plainText);
    if (text) inlineOrder.push({ kind: "text", text });
    plainText = "";
  };
  const visitInline = (node: Node): void => {
    if (node.nodeType === 3) {
      plainText += (node.textContent ?? "").replace(/\s+/g, " ");
      return;
    }
    if (node.nodeType !== 1) return;
    const element = node as Element;
    if (element.matches(CONTROL_SELECTOR) || isGeneratedFootnoteLabel(element)) return;
    if (outerCode.has(element) || element.tagName === "PRE" || element.tagName === "CODE" || element.matches(".katex")) {
      flushText();
      const tag = element.matches(".katex") ? "math" : outerCode.has(element) || element.tagName === "PRE" ? "pre" : "code";
      const attributes: Array<[string, string]> = element.matches(".katex") ? [["display", String(Boolean(element.closest(".katex-display,.math-display")))]] : [];
      inlineOrder.push({ kind: "open", tag, attributes }, { kind: "text", text: contentOf(element) }, { kind: "close", tag, attributes });
      return;
    }
    const marked = element !== root && (element.matches("a[href],h1,h2,h3,h4,h5,h6,ol,ul,li,table,thead,tbody,tfoot,tr,th,td,input[type='checkbox']") || semanticHtml(element));
    const tag = semanticTag(element);
    const attributes = semanticAttributes(element);
    if (marked) {
      flushText();
      inlineOrder.push({ kind: "open", tag, attributes });
    }
    if (BLOCK_TAGS[element.tagName]) plainText += "\n";
    if (element.matches("br,hr")) plainText += "\n";
    for (const child of element.childNodes) visitInline(child);
    if (BLOCK_TAGS[element.tagName]) plainText += "\n";
    if (marked) {
      flushText();
      inlineOrder.push({ kind: "close", tag, attributes });
    }
  };
  visitInline(root);
  flushText();

  return {
    text: contentOf(root),
    inlineCode: inlineCode.map((element) => element.textContent ?? ""),
    preformatted: preformatted.map((element) => element.textContent ?? ""),
    inlineOrder,
    codeBlocks: codeBodies.map((body) => {
      const wrapper = body.closest("[data-language]");
      const languageClass = Array.from(body.classList).find((name) => name.startsWith("language-")) ?? Array.from(body.closest("pre")?.classList ?? []).find((name) => name.startsWith("language-"));
      return { language: wrapper?.getAttribute("data-language") ?? languageClass?.slice(9) ?? "", code: renderedCodeSource(body) };
    }),
    headings: Array.from(root.querySelectorAll("h1,h2,h3,h4,h5,h6")).filter(outsideCode).map((heading) => ({ level: Number(heading.tagName.slice(1)), text: contentOf(heading) })),
    math: mathRoots.filter((element) => !element.closest("pre")).map((element) => ({ display: Boolean(element.closest(".katex-display,.math-display")), tex: mathSource(element) })),
    tables: Array.from(root.querySelectorAll("table")).filter(outsideCode).map((table) => ({
      rows: Array.from(table.querySelectorAll("tr")).filter((row) => row.closest("table") === table).map((row) => ({
        section: row.parentElement?.tagName.toLowerCase() ?? "",
        cells: Array.from(row.children).filter((cell) => cell.tagName === "TD" || cell.tagName === "TH").map((cell) => ({
          header: cell.tagName === "TH", colspan: Number(cell.getAttribute("colspan") ?? 1), rowspan: Number(cell.getAttribute("rowspan") ?? 1),
          align: cell.getAttribute("align") ?? (cell as HTMLElement).style.textAlign, text: contentOf(cell),
        })),
      })),
    })),
    lists: Array.from(root.querySelectorAll("ol,ul")).filter(outsideCode).map((list) => {
      let depth = 0;
      for (let ancestor = list.parentElement; ancestor && ancestor !== root; ancestor = ancestor.parentElement) if (ancestor.matches("ol,ul")) depth += 1;
      return {
        depth, ordered: list.tagName === "OL", start: list.tagName === "OL" ? Number(list.getAttribute("start") ?? 1) : null,
        reversed: list.hasAttribute("reversed"), markerType: list.getAttribute("type") ?? "",
        items: Array.from(list.children).filter((item) => item.tagName === "LI").map((item) => {
          const checkbox = item.querySelector<HTMLInputElement>("input[type='checkbox']");
          return { value: item.hasAttribute("value") ? Number(item.getAttribute("value")) : null, checked: checkbox?.checked ?? null, text: contentOf(item) };
        }),
      };
    }),
    links: Array.from(root.querySelectorAll("a[href]")).filter(outsideCode).map((link) => ({ url: link.getAttribute("href") ?? "", title: link.getAttribute("title") ?? "", text: contentOf(link) })),
    html: Array.from(root.querySelectorAll("*")).filter((element) => outsideCode(element) && !element.closest(".katex") && !element.matches(".math-inline,.math-display") && semanticHtml(element)).map((element) => ({
      tag: semanticTag(element),
      attributes: semanticAttributes(element),
      text: contentOf(element),
    })),
  };
}
