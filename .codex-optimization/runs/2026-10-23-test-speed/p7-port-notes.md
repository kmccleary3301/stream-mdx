# P7 port recovery

## Diagnosis
- Lezer combines the registered opener and first body prose into one `Paragraph`; `groupHtmlOwnership` therefore has no child block for that prose, and `buildRegisteredContainerTree` had emitted the range as inline text. Later body paragraphs already arrived as blocks.
- The focused assertion failed with only `["Second inside."]`; the throwaway patch-stream dump showed the first body chunk as `kind:"text"` and the second as `kind:"block"`.

## Progress
- First test now renders both inner paragraphs natively.
- The second test exposed another ownership gap: restricted-content root owners are intentionally declined, and `createBlockSnapshot` did not expose `htmlTree` block leaves as canonical store children. An attempted policy relaxation regressed open-component admission and was reverted.
- Core paragraph snapshots now include block leaves owned by `htmlTree`, alongside existing mixed-segment children; this makes nested blocks discoverable from the canonical renderer store without changing component rendering ownership.

## Next
Rebuild and rerun P7. If native code preparation/line retention still fails, trace the remaining owner patch lifecycle; then run full checks and commit.
