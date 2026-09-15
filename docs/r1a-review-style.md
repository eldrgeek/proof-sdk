# R1a: Review style

Implemented on `codex/r1a-review-style`, based on `05ef0e0`.

Readers can choose **Proof** or **PlayMaker** beside Suggesting without reloading.
Proof remains the code default. `PROOF_DEFAULT_REVIEW_STYLE=playmaker` supplies
this deployment's default through the shared page's runtime configuration; an
explicit browser preference takes precedence. No deployment is part of this change.

## File by file

| File | Change |
| --- | --- |
| `server/share-web-routes.ts` | Pass the normalized environment default into `window.__PROOF_CONFIG__.defaultReviewStyle`. |
| `src/editor/review-style.ts` | Normalize the default, remember the per-user style and walk preference, dispatch immediate style changes, and keep switching functional when storage writes fail. |
| `src/ui/playmaker-review.ts` | Top-bar selector; Marks queue with author/snippet, open/settled counts and Start review; click-position dialog; dragging; A/R/C/E/L keys; reply composer; Escape and Tab focus handling; 900 ms walk; bulk confirmation above ten suggestions. |
| `src/ui/playmaker-review.css` | Review control, queue and dialog styles; author accents; 44 px buttons; 400 px bottom sheet; small-screen top-bar layout. |
| `src/editor/review-decision-history.ts` | Review guards and stack-item metadata on the page's native y-prosemirror undo manager. |
| `src/editor/index.ts` | Mount the Review style control, connect the UI to existing mark operations, synchronize a decision's text and metadata atomically, and refresh the queue. Supply restored metadata on the same editor update as restored text. Changes are confined to review flow; the Add agent dialog is untouched. |
| `src/editor/plugins/mark-popover.ts` | Close Proof's popover on a style change and suppress its review popover/comment strip in PlayMaker. Comment creation remains available. |
| `src/editor/plugins/marks.ts` | Supply a deterministic author-colour CSS variable through existing decorations. The style switch changes presentation, not stored marks. |
| `src/tests/review-style.test.ts` | Default, runtime default, stored preference, immediate switching, walk persistence and storage-write failure coverage. |
| `src/tests/review-decision-history.test.ts` | Exact text/metadata undo, redo and preservation of intervening typing. |
| `src/tests/review-style-browser.test.ts` | Real API-created suggestions/comments, server-default propagation, keyboard walk, API readback after each step, exact undo, redo, reply/resolve, bulk actions, native typing undo, focus, dragging, responsive screenshots, reload preferences and switching back to Proof. A second document tests confirmation at eleven suggestions. |
| `docs/r1a-review-style.md` | This implementation and validation report. |

## Decision undo

Edits and review decisions share the installed **y-prosemirror undo manager**
in both styles. Its scope includes the `prosemirror` fragment and `marks` map.
Local edit transactions include derived suggestion records; each decision has
its own capture boundary and stack-item metadata. Remote updates, server writes,
standalone marks synchronization and document loads are excluded. Bulk decisions
are preflighted and captured as one operation.

Undo and redo preflight the effective stack item on an isolated Y.Doc. Decision
range checks refuse intervening text changes; tracked-typing record checks refuse
changed or replied-to suggestions. Yjs performs both undo and redo, with the
inverse range and record guards stored on the inverse item. Every nonempty XML
container is protected, preserving collaborators' text in enclosing blocks.

The editor retains y-prosemirror's typing window, relative selections and
selection restoration. A stack item also retains the post-operation relative
selection so deferred metadata delivery cannot displace redo's cursor. Installing
collaborator cursors reconnects the native manager after plugin-view recreation.

Cmd/Ctrl-Z and Shift-Cmd/Ctrl-Z use this history inside the editor and in the review
UI, regardless of style. Keyboard history keeps focus in the editor. Input fields
and reply composers retain their own text undo. Refusals appear once in either
style. Switching styles never writes document marks.

See [R1a3 validation](r1a3-unified-history.md) for fail-before/pass-after results,
production probes, final command statuses and implementation details.

Decision history lasts for the current live collaboration session. Decisions
require an editable, connected collaboration session; an unavailable connection
leaves the mark open and shows an error. Settled counts combine currently stored
settled records with a per-document browser cache of observed settlements, since
Proof removes accepted/rejected suggestion records. This cache is presentation
only, not a global audit history. Switching styles never writes document marks.

## Original R1a validation (historical)

All commands below were run locally. Browser tests ran after `npm run build`.
Each command captured its status separately with `; rc=$?; echo "rc=$rc"`;
no exit status was taken through a pipe. Long output was redirected to files in
`/tmp/proof-r1a-*.log`.

| Command | Final exit code |
| --- | ---: |
| `npm run build` | 0 |
| `npx tsx src/tests/review-style.test.ts` | 0 |
| `npx tsx src/tests/review-decision-history.test.ts` | 0 |
| `npx tsx src/tests/review-style-browser.test.ts` | 0 |
| `npm test` | 0 |
| `npx tsx src/tests/suggestions-key-by-key.test.ts` | 0 |
| `npx tsx src/tests/track-changes-race.test.ts` | 0 |
| `PROOF_PLAYWRIGHT_PACKAGE_JSON="$PWD/package.json" NODE_PATH="$PWD/node_modules" npx tsx src/tests/collab-rest-suggestion-live-persistence-regression.test.ts` | 0 |
| `PROOF_PLAYWRIGHT_PACKAGE_JSON="$PWD/package.json" NODE_PATH="$PWD/node_modules" npx tsx src/tests/collab-concurrent-typing-browser.test.ts` | 0 |
| `npx tsc --noEmit` | 2 |
| `git diff --check` | 0 |

TypeScript had **475 diagnostics before the change and 475 after**, with no new
diagnostics after accounting for source-line shifts. The repository-wide type
check therefore remains nonzero; no new error was introduced in a touched file.

The five requested existing suites passed both their first run and the final
regression rerun. Builds and unit runs returned 0. During development, seven
earlier runs of `review-style-browser.test.ts` returned 1 while exposing initial
render timing, undo/redo hydration, an incorrect Proof-popover test selector and
a platform-specific native undo key. These issues were corrected. The last two
complete browser runs returned 0, including eleven-mark confirmation and exact
stored-state checks. Type checks returned 2 throughout, including the baseline.

## Screenshots

Generated by the browser test, under the worktree's ignored `test-results/r1a/`:

- `review-1280.png`: dialog and Marks panel at 1280 × 900.
- `marks-1280.png`: Marks panel at 1280 × 900.
- `review-400.png`: bottom-sheet dialog and Marks panel at 400 × 900.
- `marks-400.png`: Marks panel at 400 × 900.

Only this worktree and system temporary files were written. No push, server
migration, deployment, upstream PR, or change to the PlayMaker repository was made.
