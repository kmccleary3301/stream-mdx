import { decodeNamedCharacterReference } from "./entities/named-character-reference";

type WorkerDocument = {
  createElement: (tag: string) => { _inner: string; innerHTML: string; textContent: string };
  compatMode?: "CSS1Compat" | "BackCompat";
};

type WorkerDOMStubScope = { document?: WorkerDocument };

if (typeof document === "undefined") {
  // Worker decoding needs only this DOM subset, not a browser Document.
  const workerGlobal = globalThis as unknown as WorkerDOMStubScope;
  workerGlobal.document = {
    compatMode: "CSS1Compat",
    createElement() {
      return {
        _inner: "",
        set innerHTML(value: string) {
          this._inner = value;
        },
        get innerHTML(): string {
          return this._inner;
        },
        get textContent(): string {
          const match = /^&([^;]+);$/.exec(this._inner);
          if (match) {
            const decoded = decodeNamedCharacterReference(match[1]);
            if (decoded !== false) {
              return decoded;
            }
          }
          return this._inner;
        },
      };
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
