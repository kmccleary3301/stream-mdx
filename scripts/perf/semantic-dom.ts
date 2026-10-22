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

function canonicalLinkUrl(url: string): string {
  // Do not resolve relative targets against the benchmark page's port/query.
  if (!/^\s*https?:\/\//i.test(url)) return url;
  try {
    return new URL(url).href;
  } catch {
    // Invalid authored destinations retain their original DOM evidence.
    return url;
  }
}

function generatedFootnoteGraph(root: HTMLElement) {
  const ids = new Map<string, Element[]>();
  for (const element of root.querySelectorAll("[id]")) {
    const matches = ids.get(element.id) ?? [];
    matches.push(element);
    ids.set(element.id, matches);
  }
  const unique = (element: Element): boolean => Boolean(element.id) && ids.get(element.id)?.length === 1;
  const identities = new Map<Element, string>();
  const items = new Map<Element, { namespace: "native" | "streamdown"; label: string; ordinal: string }>();
  const references = new Map<Element, Element>();
  let sectionIndex = 0;
  for (const section of root.querySelectorAll("section.footnotes,section[data-footnotes]")) {
    sectionIndex += 1;
    const namespace = section.matches("[data-footnotes]") ? "streamdown" : "native";
    const list = Array.from(section.children).find((child) => child.tagName === "OL");
    if (!list) continue;
    let itemIndex = 0;
    for (const item of Array.from(list.children).filter((child) => child.tagName === "LI")) {
      itemIndex += 1;
      const match = namespace === "native" ? /^fn:(\d+)$/.exec(item.id) : /^user-content-fn-(.+)$/.exec(item.id);
      const ordinal = `${sectionIndex}:${itemIndex}`;
      identities.set(item, match && unique(item) ? `footnote:${ordinal}` : `invalid:${item.id}:${ids.get(item.id)?.length ?? 0}`);
      if (match && unique(item)) items.set(item, { namespace, label: match[1], ordinal });
    }
  }
  const resolve = (value: string): Element | undefined => {
    if (!value.startsWith("#")) return undefined;
    let id: string;
    try { id = decodeURIComponent(value.slice(1)); } catch { return undefined; }
    const matches = ids.get(id);
    return matches?.length === 1 ? matches[0] : undefined;
  };
  const occurrences = new Map<Element, number>();
  for (const reference of root.querySelectorAll("sup.footnote-ref > a,a[data-footnote-ref]")) {
    const item = resolve(reference.getAttribute("href") ?? "");
    const info = item && items.get(item);
    let valid = false;
    if (info) {
      const prefix = info.namespace === "native" ? `fnref:${info.label}` : `user-content-fnref-${info.label}`;
      const suffix = reference.id.slice(prefix.length);
      valid = unique(reference) && reference.id.startsWith(prefix) &&
        (suffix === "" || (info.namespace === "native" ? /^:(?:[2-9]|[1-9]\d+)$/.test(suffix) : /^-(?:[2-9]|[1-9]\d+)$/.test(suffix))) &&
        (info.namespace === "native" ? reference.parentElement?.matches("sup.footnote-ref") === true : reference.hasAttribute("data-footnote-ref"));
    }
    if (!valid || !item || !info) {
      identities.set(reference, `invalid:${reference.id}:${ids.get(reference.id)?.length ?? 0}`);
      continue;
    }
    const occurrence = (occurrences.get(item) ?? 0) + 1;
    occurrences.set(item, occurrence);
    identities.set(reference, `footnote:${info.ordinal}:reference:${occurrence}`);
    references.set(reference, item);
  }
  const destinations = new Map<Element, string>();
  for (const [reference, item] of references) destinations.set(reference, `#${identities.get(item)}`);
  for (const backref of root.querySelectorAll("a.footnote-backref,a[data-footnote-backref]")) {
    const reference = resolve(backref.getAttribute("href") ?? "");
    const item = reference && references.get(reference);
    if (item && backref.closest("li") === item) destinations.set(backref, `#${identities.get(reference)}`);
  }
  return {
    identity: (element: Element) => identities.get(element),
    attribute: (element: Element, name: string, value: string): string => {
      if (name === "href") return destinations.get(element) ?? canonicalLinkUrl(value);
      if (name === "aria-describedby" || name === "aria-labelledby") {
        return value.split(/\s+/).map((id) => {
          const label = resolve(`#${id}`);
          return label && isGeneratedFootnoteLabel(label) ? "generated-footnote-label" : id;
        }).join(" ");
      }
      return value;
    },
  };
}

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
  const footnotes = generatedFootnoteGraph(root);
  const codeBodies = Array.from(root.querySelectorAll("pre code"));
  const generatedOwners = new Map<Element, Element>();
  for (const body of codeBodies) {
    const wrapper = body.closest(".markdown-code-block,[data-streamdown='code-block']");
    if (!wrapper) continue;
    const frame = wrapper.closest("div[data-code-block='true'][data-block-id][data-code-total-lines]");
    const frameContent = wrapper.parentElement;
    const isDirectFrameContent = frameContent === frame;
    const isVirtualFrameContent =
      frameContent?.matches("div.markdown-code-block-container") === true && frameContent.parentElement === frame;
    const virtualContentIsGenerated =
      isVirtualFrameContent &&
      Array.from(frameContent!.childNodes).every((child) =>
        child === wrapper ||
        (child.nodeType === 1 && (child as Element).matches("div[aria-hidden='true']")) ||
        (child.nodeType === 3 && !child.textContent?.trim()),
      );
    const frameContentElement = virtualContentIsGenerated ? frameContent! : wrapper;
    // The public native DIV frame owns one highlighted fence; the inner PRE/CODE structure is renderer-generated.
    const nativeFrame = wrapper.matches("div.markdown-code-block") && frame !== null;
    const ownsNativeFrame = nativeFrame && frame !== null &&
      body.parentElement?.tagName === "PRE" && body.parentElement.parentElement === wrapper &&
      body.parentElement.childNodes.length === 1 && body.parentElement.firstChild === body &&
      Array.from(body.querySelectorAll("*")).every((child) => child.tagName === "SPAN" &&
        !Array.from(child.attributes).some((attribute) => /^(href|src|alt|title|open|datetime|cite|lang|dir|role|target|rel|download|type|checked|disabled|aria-)/.test(attribute.name))) &&
      wrapper.children.length === 1 && wrapper.firstElementChild === body.parentElement &&
      Array.from(wrapper.childNodes).every((child) => child === body.parentElement || (child.nodeType === 3 && !child.textContent?.trim())) &&
      (isDirectFrameContent || virtualContentIsGenerated) &&
      frame.children.length === 1 && frame.firstElementChild === frameContentElement &&
      Array.from(frame.childNodes).every((child) => child === frameContentElement || (child.nodeType === 3 && !child.textContent?.trim()));
    if (nativeFrame && !ownsNativeFrame) continue;
    generatedOwners.set(body, ownsNativeFrame && frame ? frame : wrapper);
  }
  const preformatted = Array.from(root.querySelectorAll<Element>("pre")).filter((element) => {
    if (element.closest(CONTROL_SELECTOR)) return false;
    if (Array.from(generatedOwners.values()).some((owner) => owner === element || owner.contains(element))) return false;
    const code = element.querySelector("code");
    if (!code) return true;
    // Renderer-owned fences replace their whole wrapper with the code source.
    // Authored PRE siblings, including whitespace, are visible source too.
    return (element.childNodes.length !== 1 || element.firstChild !== code ||
        Array.from(code.querySelectorAll("*")).some((child) => child.tagName !== "SPAN" ||
          Array.from(child.attributes).some((attribute) => /^(href|src|alt|title|open|datetime|cite|lang|dir|role|aria-)/.test(attribute.name))));
  });
  const outerCode = new Map<Element, { body: Element; index: number }>();
  for (const body of codeBodies) {
    const pre = body.closest("pre");
    if (!pre || preformatted.includes(pre)) continue;
    const wrapper = generatedOwners.get(body) ?? pre;
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
    // Display math is block content (KaTeX CSS: `.katex-display { display: block }`), whether wrapped in a div or a bare span.
    if (element.matches(".katex")) return element.closest(".katex-display,.math-display") ? `\n${mathSource(element)}\n` : ` ${mathSource(element)} `;
    if (element.tagName === "BR") return "\n";
    if (element.tagName === "HR") return "\n";
    const content = Array.from(element.childNodes, textOf).join("");
    if (element.tagName === "TD" || element.tagName === "TH") return `${content}\t`;
    return BLOCK_TAGS[element.tagName] || element.matches("ul,ol") ? `\n${content}\n` : content;
  };
  const normalizeText = (text: string): string => text.replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  const contentOf = (element: Element): string => normalizeText(textOf(element))
    .replace(/\uFFF0(\d+)\uFFF1/g, (_, index: string) => renderedCodeSource(codeBodies[Number(index)]))
    .replace(/\uFFF2(\d+)\uFFF3/g, (_, index: string) => inlineCode[Number(index)].textContent ?? "")
    .replace(/\uFFF4(\d+)\uFFF5/g, (_, index: string) => preformatted[Number(index)].textContent ?? "");
  const outsideCode = (element: Element): boolean => !element.closest("pre,.markdown-code-block,[data-streamdown='code-block']") && !element.closest(CONTROL_SELECTOR) && !isGeneratedFootnoteLabel(element);

  const semanticTag = (element: Element): string => element.matches('[data-streamdown="strong"]') ? "strong" : element.tagName.toLowerCase();
  const semanticAttributes = (element: Element): Array<[string, string]> => {
    const checkbox = element.matches("input[type='checkbox']");
    const attributes = Array.from(element.attributes)
      .filter((attribute) => /^(href|src|alt|title|open|datetime|cite|lang|dir|role|target|rel|download|type|checked|disabled|aria-)/.test(attribute.name) &&
        !(checkbox && (attribute.name === "checked" || attribute.name === "disabled" || attribute.name === "type")))
      .map((attribute): [string, string] => {
        let value = footnotes.attribute(element, attribute.name, attribute.value);
        if (attribute.name === "rel") value = Array.from(new Set(value.toLowerCase().split(/\s+/).filter(Boolean))).sort().join(" ");
        if (attribute.name === "target" && /^_(blank|self|parent|top)$/i.test(value)) value = value.toLowerCase();
        if (attribute.name === "checked" || attribute.name === "disabled") value = "true";
        return [attribute.name, value];
      });
    if (checkbox) {
      // The selector establishes this HTMLInputElement DOM boundary.
      const input = element as HTMLInputElement;
      attributes.push(["type", input.type], ["checked", String(input.checked)], ["disabled", String(input.disabled)]);
    }
    const identity = footnotes.identity(element);
    if (identity) attributes.push(["footnote-target", identity]);
    return attributes.sort(([left], [right]) => left.localeCompare(right));
  };
  const semanticHtml = (element: Element): boolean => Boolean(footnotes.identity(element)) || element.matches("details,summary,abbr,mark,time,img,video,audio,iframe,blockquote,hr,strong,em,b,u,s,button,del,ins,kbd,sup,sub,[data-streamdown='strong']") ||
    semanticAttributes(element).some(([name]) => /^(alt|title|open|datetime|cite|lang|dir|role|target|rel|download|type|checked|disabled|aria-)/.test(name));
  // Enter/exit events associate repeated text with its inline semantics. Plain
  // styling spans contribute text but no events, including Shiki token wrappers.
  const inlineOrder: SemanticDomRecords["inlineOrder"] = [];
  let plainText = "";
  const flushText = (literal = false): void => {
    const text = literal ? plainText : normalizeText(plainText);
    if (text) inlineOrder.push({ kind: "text", text });
    plainText = "";
  };
  const visitInline = (node: Node, literal = false): void => {
    if (node.nodeType === 3) {
      plainText += literal ? node.textContent ?? "" : (node.textContent ?? "").replace(/\s+/g, " ");
      return;
    }
    if (node.nodeType !== 1) return;
    const element = node as Element;
    if (element.matches(CONTROL_SELECTOR) || isGeneratedFootnoteLabel(element)) return;
    if (outerCode.has(element) || element.matches(".katex")) {
      flushText(literal);
      const tag = element.matches(".katex") ? "math" : "pre";
      const attributes: Array<[string, string]> = element.matches(".katex") ? [["display", String(Boolean(element.closest(".katex-display,.math-display")))]] : [];
      inlineOrder.push({ kind: "open", tag, attributes }, { kind: "text", text: contentOf(element) }, { kind: "close", tag, attributes });
      return;
    }
    const tag = semanticTag(element);
    const soleListParagraph = element.tagName === "P" && element.parentElement?.tagName === "LI" && element.parentElement.children.length === 1;
    const cosmeticWrapper = (element.tagName === "DIV" || element.tagName === "SPAN") && !semanticHtml(element);
    const marked = element !== root && !soleListParagraph && !cosmeticWrapper;
    const childLiteral = literal || element.tagName === "PRE" || element.tagName === "CODE";
    const attributes = semanticAttributes(element);
    if (marked) {
      flushText(literal);
      inlineOrder.push({ kind: "open", tag, attributes });
    }
    if (!childLiteral && BLOCK_TAGS[element.tagName]) plainText += "\n";
    if (element.matches("br,hr")) plainText += "\n";
    for (const child of element.childNodes) visitInline(child, childLiteral);
    if (!childLiteral && BLOCK_TAGS[element.tagName]) plainText += "\n";
    if (marked) {
      flushText(childLiteral);
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
      const language = wrapper?.getAttribute("data-language") ?? languageClass?.slice(9) ?? "";
      return { language: generatedOwners.has(body) && !language ? "text" : language, code: renderedCodeSource(body) };
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
    links: Array.from(root.querySelectorAll("a[href]")).filter(outsideCode).map((link) => ({ url: footnotes.attribute(link, "href", link.getAttribute("href") ?? ""), title: link.getAttribute("title") ?? "", text: contentOf(link) })),
    html: Array.from(root.querySelectorAll("*")).filter((element) => outsideCode(element) && !element.closest(".katex") && !element.matches(".math-inline,.math-display") && semanticHtml(element)).map((element) => ({
      tag: semanticTag(element),
      attributes: semanticAttributes(element),
      text: contentOf(element),
    })),
  };
}
