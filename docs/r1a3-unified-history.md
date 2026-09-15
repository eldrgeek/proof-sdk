# R1a3: one edit and review history

Base: `0ebd14f`. Production code probed: `0adfebc`. Branch:
`codex/r1a-review-style`. All work and tests ran locally; no deployment or upstream PR.

## Findings and regression evidence

The two regression files existed uncommitted before implementation. The recovered
baseline log, a fresh detached-baseline unit run, and a real-page baseline run establish the failures below.

| Finding | Change and proof | R1a2 before | Fixed result | Production `0adfebc` |
| --- | --- | --- | --- | --- |
| 1. Undo deletes Bob's enclosing blockquote | `review-unified-history.test.ts 1`: two connected Y.Docs, real sync/undo/marks plugins; Alice's characters disappear and Bob's survive undo, redo and another undo. Tests blockquotes, both list types and their items, tables/rows/cells/headers, headings and code blocks. The native delete filter now protects every nonempty XML container. | rc=1; Bob's text disappears | rc=0 | **Bug present**, fresh probe rc=1 on the blockquote. |
| 2. Replied-to tracked typing becomes orphaned | `review-unified-history.test.ts 2`: snapshot affected suggestion records and their observed versions on the typing stack item; compare before either live stack changes. Refuse with “Can't undo: someone has replied to this suggestion.” Otherwise undo/redo text and exact records together. Browser test checks the refusal once in each style with a second editor replying. | rc=1; expected refusal missing | rc=0 | **Bug present**, fresh probe rc=1: text=false, record=true, reply=true. |
| 3. Style changes split history | `review-unified-history.test.ts 3` and `review-unified-history-browser.test.ts`: borrow the installed native manager, extend its scope to marks, and route both styles to it. Proof's local mark commands also enter atomic decision transactions. Test both style-switch directions. | unit rc=1; browser rc=1 | rc=0 | **Not applicable**: R1a and its style switch are absent. |
| 4. Redo misplaces the cursor | `review-unified-history.test.ts 4` and the browser test: retain native relative-selection metadata and the selection after each grouped operation. Seed the native restoration from the effective stack item, including after metadata refreshes. Keyboard undo preserves editor focus. Redo lands at 7; the next keystroke produces `OrigXYZinalSecond`. | unit rc=1, position 14 instead of 7; browser rc=1 | rc=0 | **Native probe passes**, fresh rc=0, position 7. This is a code-level native-history probe, not a production-site browser claim. |

## Design and preserved behavior

- The page uses the manager already installed by `yUndoPlugin`; there is no second edit or decision manager. Standalone unit fixtures may construct one manager when no editor plugin exists.
- The native 500 ms capture window groups typing. Decisions stop capturing on both sides and keep their own range metadata in `StackItem.meta`. Yjs performs redo; decisions are not replayed as new application commands.
- An isolated preview identifies the entry Yjs would actually pop, including superseded reply entries. Refusal checks run before live stacks, text or marks change. Inverse range and suggestion-record checks travel with the inverse stack item.
- Record versions detect replacements even when the new record has identical contents; Yjs would otherwise preserve the replacement while deleting the original text. The added identical-record test failed before this guard (rc=1) and passes after (rc=0). Own captured decisions and their undo/redo preserve the original record lineage: undoing my own reply still permits undoing my typing. That added test also failed before refinement (rc=1) and passes after (rc=0). Version observers are detached on adapter or document destruction.
- Text and derived metadata share a local transaction. Explicit edit/decision origins are tracked; standalone `local-marks-sync`, remote and server origins are excluded. The dispatcher excludes document loads and non-history transactions.
- Delayed cursor-plugin installation recreates plugin views. Upstream yUndoPlugin destroys the manager's subscriptions despite retaining its plugin state. The installation path reconnects that same manager after the new native selection hooks attach. Document replacement still destroys the old plugin manager; the review adapter checks both document and manager identity.
- `review-unified-history.test.ts 5` verifies repeated plugin recreation, typing groups, edit/decision ordering, origin exclusion and subscription cleanup.
- Existing decision collaboration and browser suites retain the original six fixes: intervening-text refusal on undo and redo, exact deferred metadata delivery, correct skipping of superseded replies, all-or-nothing bulk preflight and requiring the dialog to acknowledge changed proposals. Style normalization and E1's deferred marks delivery remain in place.

## Command results

Each command captured its exit code with its own `; rc=$?; echo "... rc=$rc"` statement. No status was taken through a pipe. Logs are local under `/tmp/proof-r1a3-logs`; raw server logs may contain test credentials and are not reproduced here.

| Command | Exit code |
| --- | ---: |
| `npm run build` | 0 |
| `npm test` | 0 |
| `npx tsx src/tests/review-style.test.ts` | 0 |
| `npx tsx src/tests/review-decision-history.test.ts` | 0 |
| `npx tsx src/tests/review-decision-collab.test.ts` | 0 |
| `npx tsx src/tests/review-unified-history.test.ts` | 0 |
| `npx tsx src/tests/review-style-browser.test.ts` | 0 |
| `npx tsx src/tests/review-decision-collab-browser.test.ts` | 0 |
| `npx tsx src/tests/collab-concurrent-typing-browser.test.ts` | 0 |
| `npx tsx src/tests/collab-load-remote-update-regression.test.ts` | 0 |
| `npx tsx src/tests/collab-rest-suggestion-live-persistence-regression.test.ts` | 0 |
| `npx tsx src/tests/review-unified-history-browser.test.ts` | 0 |
| `npx tsc --noEmit` | 2 |
| `git diff --check` | 0 |

TypeScript reports the same **475 existing diagnostics** before and after, with
no added diagnostic after normalizing line-number shifts, and no new error in any
touched file. After the final record-version refinement, build, the new browser
test, all five unified-history groups, decision-history and decision-collaboration
unit tests, and TypeScript were checked again. The required browser suites had
also passed both their initial and subsequent full runs.

Each of finding groups 1–4 was additionally run as its own command on a detached
`0ebd14f` checkout (rc=1 for each) and on the fixed worktree (rc=0 for each).
The final group 2 also covers identical remote replacement and undoing one's own
reply before undoing typing.

## Browser failures and reruns

The initial new browser test failed on R1a2 (rc=1), and its isolated rerun also
failed (rc=1): both switches could not undo, and both same-style cursor probes
failed redo. During implementation, isolated runs exposed the retained-but-detached
native manager, transient selection loss during metadata delivery, and keyboard
undo focusing the Marks button. After those fixes the original four browser cases
passed (rc=0). An added Proof acceptance probe failed before its capture fix
(rc=1) and passed after it (rc=0). The final test additionally covers replied-to
tracked typing in both styles. Its first run and isolated rerun failed (rc=1 each)
because the test waited for suggestion replies on `Mark.data`, where they are not
exposed. Reading the authoritative shared-map record corrected the test, which
then passed (rc=0).

No required browser suite other than the new regression test failed in its initial
run. Final runs and any further isolated reruns are listed with the command results.
