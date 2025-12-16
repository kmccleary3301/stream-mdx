import * as characterEntities from "character-entities";

declare global {
  // eslint-disable-next-line no-var
  var document:
    | {
        createElement: (tag: string) => { innerHTML: string; textContent: string };
        compatMode?: "CSS1Compat" | "BackCompat";
      }
    | undefined;
}

if (typeof document === "undefined") {
  const entityMap = characterEntities as unknown as Record<string, string>;
  (globalThis as typeof globalThis & { document?: typeof document }).document = {
    compatMode: "CSS1Compat",
    createElement() {
      return {
        _inner: "",
        set innerHTML(value: string) {
          this._inner = value;
        },
        get innerHTML() {
          return this._inner;
        },
        get textContent() {
          const match = /^&([^;]+);$/.exec(this._inner);
          if (match) {
            const entity = entityMap[match[1]];
            if (typeof entity === "string") {
              return entity;
            }
          }
          return this._inner;
        },
      } as { innerHTML: string; textContent: string; _inner?: string };
    },
  };
}

// Minimal DOMParser stub for worker environments. This avoids ReferenceError in
// dependencies that probe for DOMParser (e.g., DOMPurify or highlight helpers)
// while keeping the implementation lightweight. It provides enough shape for
// querySelector/querySelectorAll and basic text extraction.
if (typeof (globalThis as { DOMParser?: unknown }).DOMParser === "undefined") {
  class DOMParserStub {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    parseFromString(content: string, _type?: string) {
      const text = content ?? "";
      const noop = () => null;
      const emptyList = () => [] as unknown[];
      return {
        textContent: text,
        innerHTML: text,
        documentElement: { textContent: text, innerHTML: text },
        body: {
          innerHTML: text,
          textContent: text,
          firstChild: null,
          querySelector: noop,
          querySelectorAll: emptyList,
          appendChild: noop,
          removeChild: noop,
        },
        createElement() {
          return {
            innerHTML: "",
            textContent: "",
            querySelector: noop,
            querySelectorAll: emptyList,
            appendChild: noop,
            removeChild: noop,
          };
        },
        querySelector: noop,
        querySelectorAll: emptyList,
      };
    }
  }
  (globalThis as typeof globalThis & { DOMParser?: unknown }).DOMParser = DOMParserStub as unknown as typeof DOMParser;
}
