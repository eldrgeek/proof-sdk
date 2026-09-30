# R1a2 validation

Base: `a0a0ce6`, branch `codex/r1a-review-style`. The regressions were written before their fixes and run against the base. Refined fixtures were also rerun in an isolated detached checkout at `/tmp/proof-r1a2-base`. No deployment or upstream changes were made.

## Findings

`U` below is `src/tests/review-decision-collab.test.ts`; `B` is `src/tests/review-decision-collab-browser.test.ts`. Their numbered cases correspond to the findings.

| Finding | What is now true | Proof | Base → fixed |
| --- | --- | --- | --- |
| 1. Structural undo removes another writer's text | Record the affected text and structure using Yjs relative positions; refuse before mutation if they differ. Every retained UndoManager also uses y-prosemirror's `defaultDeleteFilter`. | U1: accepted extra paragraph, Bob edits it, undo refuses on both connected docs. | FAIL → PASS |
| 2. Receiving page overwrites restored metadata | Marks-sync records transaction provenance and persists only local changes. Receiving/restoring editor transactions use authoritative shared metadata. Text and restored records share the undo transaction. | U2 and B2: exact record, replies and `createdAt` survive on both pages/maps; B2 also checks `/state`. | FAIL → PASS, both runners |
| 3. Redo follows a skipped reply callback | Store decision ranges and operation order on Yjs stack items. Preview on an isolated Y.Doc identifies the effective item before touching live state. Native Yjs redo restores it; callbacks are never replayed. | U3: superseded reply is skipped, acceptance is undone/redone, replies remain Alice/Bob. | FAIL → PASS |
| 4. Redo deletes intervening text | Record the affected text after undo and verify it before redo. Show the persistent one-line refusal. | U4 and B4: `OrigBOBinal` survives on both peers; B4 checks the refusal and `/state`. | FAIL → PASS, both runners |
| 5. Bulk rejection partially succeeds | Prepare every command against isolated ProseMirror state, with no events, tombstones or persistence. Apply the prepared batch once only if all pass. Report the failure count and highlight its rows. | B5: eleven suggestions, one stale structural insertion; confirmed rejection leaves all eleven and all text/records unchanged. Existing R1a browser test verifies successful batch undo. | FAIL → PASS |
| 6. Dialog accepts unseen content | Compare the displayed revision with the current mark. Refresh on changes and require acknowledgment before applying. Removed/resolved marks stay visible with disabled mutation buttons. | B6: remote replacement changes while open; first Accept applies nothing, second applies refreshed text. | FAIL → PASS |

Both complete regression runners exited **1 on the base and 0 after the fixes**. Each numbered case logged its own FAIL/PASS result.

### Keyboard history

The additional B `history-order` case failed on the base and passes after the fix. It checks edit → decision undo order across text/queue focus, then both redos, using editor document text rather than rendered suggestion previews.

Typing uses a separate scoped Yjs manager with a 500 ms capture window. Decisions retain their own manager with one entry per decision. Both use stack-item ordering for Cmd/Ctrl-Z and Shift-Cmd/Ctrl-Z. Ordinary typing and remote transactions remain excluded from the decision manager. New local changes invalidate redo; changes received from another writer do not.

## Final commands and exit codes

Every command was followed by `rc=$?; echo "rc=$rc"` as its own statement, with no pipe. Runtime logs are under `test-results/r1a2/` (ignored by git).

| Command | Exit code |
| --- | ---: |
| `npm run build` | 0 |
| `npm test` | 0 |
| `npx tsx src/tests/review-style.test.ts` | 0 |
| `npx tsx src/tests/review-decision-history.test.ts` | 0 |
| `npx tsx src/tests/review-decision-collab.test.ts` | 0 |
| `npx tsx src/tests/review-style-browser.test.ts` | 0 |
| `npx tsx src/tests/review-decision-collab-browser.test.ts` | 0 |
| `npx tsx src/tests/collab-load-remote-update-regression.test.ts` | 0 |
| `npx tsx src/tests/collab-concurrent-typing-browser.test.ts` | 0 on isolated rerun; 1 on preceding concurrent run |
| `npx tsx src/tests/collab-rest-suggestion-live-persistence-regression.test.ts` | 0 |
| `npx tsc --noEmit` | 2, same existing diagnostics; **0 new diagnostics in touched files** |
| Supplemental: `npx tsx src/tests/marks.test.ts` | 1 on both base and fixed source; same three failures |

The concurrent-typing suite passed earlier in this session. One final run alongside four other browser suites failed its suggestion-coverage assertion (one unmarked character); the isolated rerun passed all four scenarios with exit 0 (`verified-typing-retry.log`).

The three supplemental baseline failures concern contextual target metadata, markdown-flavored target metadata, and canonical cross-paragraph anchors in `applyRemoteMarks`. They are unchanged. The six requested findings are fixed; these unrelated baseline failures and repository-wide type errors remain outside this patch.
