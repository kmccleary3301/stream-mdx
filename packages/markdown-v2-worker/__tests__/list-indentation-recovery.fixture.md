Execute the full layout refresh plan for the sample project.

 Root:
 - /workspace/sample-project/packages/layout

 Primary plan:
 -
 docs/plans/layout_refresh_sprint_20260101/SAMPLE_LAYOUT_REFRESH_PLAN_WITH_A_VERY_LONG_FILE
 NAME_SPLIT.md

 Context:
 - Continue from the completed measurement sprint and the previous snapshot
 work.
 - Use the plan exactly as the acceptance contract.
 - Target the hybrid design: ledgered renderer contract plus
 source-backed replay for owned rows.

 Scope:
 1. Implement the ledger as the semantic source for replayable document
 rows.
 2. Add source-backed render APIs for prompts, markdown, tool calls/results,
 and status rows.
 3. Separate host history, owned rows, live tail, overlays, and
 footer chrome.
 4. Implement the resize scheduler with width detection, debounce, row caps, stream-time
 resize flags, and final repair.
 5. Implement the replay stage:
   - clear only the owned region
   - preserve host history
   - exclude footer chrome
   - replay from the semantic source
 6. Keep the snapshot fallback available.
 7. Add the rich-block policy:
   - hold previews while live
   - replay from source after finalization
   - compact detail surfaces where needed
 8. Add detail overlays so detail surfaces render at the current
 width.
 9. Add the required invariants:
   - HOST-PREFIX-PRESERVED
   - REPLAY-GENERATION-OBSERVED
   - ROWS-SOURCE-BACKED
   - NO-CHROME-REPLAY
   - CELL-CARDINALITY-STABLE
   - ROW-CAP-OBEYED
   - FINAL-REPAIR-RAN
   - BLOCK-HELD-UNTIL-FINAL
   - SURFACE-CURRENT-WIDTH
 10. Add the full scenario batch from the plan, including host-prefix, duplicate-card,
 row-cap, final-repair, table/code/diff/mixed markdown, tool/preview, overlay/detail,
 and resize-drag-debounce
 scenarios.

 Execution rules:
 - Work through the plan end-to-end.
 - Default to a clean cutover inside the new mode, but preserve the
 fallback.
 - Do not silently weaken any invariant or scenario to pass.
 - Treat terminal behavior as evidence-driven: proof is required for
 terminal-surface changes.

 Required verification:
 - Add unit tests for every ledger, scheduler, and replay invariant.
 - Run targeted tests for changed files.
 - Produce a closeout artifact listing changed files, scenario artifact directories,
 verification commands, and remaining risks.

 Acceptance:
 - Every deliverable in the plan is implemented or
 explicitly blocked with direct evidence.
 - All new and changed unit tests pass.
 - The snapshot fallback remains available and tested.
