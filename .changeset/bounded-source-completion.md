---
"@stream-mdx/core": patch
"@stream-mdx/protocol": patch
"@stream-mdx/worker": patch
"@stream-mdx/react": patch
"stream-mdx": patch
---

Bound host-accepted and in-flight source with generation-tagged worker admission acknowledgements. Imperative append accepts a whole UTF-16 chunk or refuses it without partial admission; automatic iterators losslessly split larger chunks and wait for capacity.

Finalization seals the host generation immediately and resolves one shared promise after all earlier accepted source reaches the matching native finalization and semantic store barrier. Reset invalidates pending capacity/finalization waits, including automatic source replacement on a reused renderer. The barrier does not imply a React commit or optional enrichment readiness.

Cache inline regex eligibility per immutable parser context, rather than rescanning the whole context at each token position. A later marker-bearing context still performs its own check, and weak keys do not retain completed contexts.

Demo automation now observes synchronous source and completion state immediately after fast-forward or finalization, and restart opens a fresh wrapper session before replacing its worker.
