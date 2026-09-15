# C7: can an AI's write remove text a person is typing? Prove it with tests, and fix only what a test shows

Your branch is based on 00c0e15 in the fork (branch `integ/2026-09-15-00c0e15`; it becomes `deploy/vps` once the live
checks pass). 00c0e15 is upstream fb25787 plus every fix in flight: B7, C4/C4b/C4c, C5, C6, B8c, B2d, B2e and B8d.
B8d (commit 6c977bc) added a `canonical-reconcile` branch to `persistDoc` in server/collab.ts.

Stay out of the collab `onChange` handlers (B2d/B2e) and the B8c insert-structure builder, unless a test you wrote
proves one of them loses text.

## Setup
- `ln -s /Users/mikewolf/Projects/proof-sdk/node_modules node_modules`; if anything is missing run
  `npm install --no-package-lock`. `npm run build`; `npm test`. Never touch the live VPS server.
- Known baseline failures (they also fail on untouched upstream fb25787; not yours): src/tests/marks.test.ts (3),
  share-event-poll-fallback-wiring, marks-accept-live-viewer-stability-regression, agent-edit-v2-live-viewer-regression,
  agent-edit-v2-live-structural-drift-regression, collab-onstore-drift-quarantine, share-server-startup.
  The COS confirmed collab-onstore-drift-quarantine fails identically on fb25787, 5b5c779 and 00c0e15.
- The two-browser test needs `PROOF_PLAYWRIGHT_PACKAGE_JSON=/Users/mikewolf/Projects/playmaker/package.json`.

## Facts the COS (Claude) verified
On the live instance, build 5b5c779, fresh documents, one person typing in Chromium in Suggesting mode:
1. While the person typed continuously (90 ms per key), both AI `suggestion.add` calls returned
   409 `PROJECTION_STALE`, so the AI could not write at all (doc h5njge9c).
2. With the person typing in four bursts and a 1.5 s pause between them, and each AI call retried every 250 ms on
   409, the AI's replace, insert and reject were all accepted while the person was still typing (at 3.0 s, 3.1 s and
   7.1 s). The whole phrase survived on the page, after a reload and on the server, and the server was fresh
   (doc pr0v00pa). So the live check has not reproduced a loss. It exercises each window only a few times, which is why
   this brief asks for deterministic tests.
3. The same check on 00c0e15 (doc h3vfqrex) gave the same result: the AI's replace (7 attempts, 3.0 s), insert
   (3.1 s) and reject were accepted while the person typed, nothing was lost, and the server was fresh.

From reading the code (00c0e15). These are two candidate windows, not proven losses:
- **Window 1: save-conflict reconcile.** `resolveOnStoreConflict` (server/collab.ts ~8952–8994) returns
  `canonical-reconcile` with the ROW's markdown whenever the in-memory markdown or marks differ from the row, the row's
  marks differ from the persisted Yjs marks, and the row has any marks. Nothing checks that the row's text contains
  the text in the live fragment. `persistDoc` (~7961–7974, new in B8d) and `onStoreDocument` (~9153, present before
  B8d) then call `applyCanonicalDocumentToCollab`, whose inner function (~10055) can `replaceYXmlFragment` on the live
  doc. If a person's newest typing is in the live fragment but not yet in the row, that looks able to erase it.
- **Window 2: a keystroke during the mutation's awaits.** `mutateCanonicalDocument` (server/canonical-document.ts)
  re-checks the live base at ~1016–1050 (`STALE_BASE` "Document changed during mutation"). After that check it still
  awaits: ~1062–1063 (fragment hash checks), ~1088 (`serializeMarkdown`) and ~1137
  (`deriveMarkdownFromCanonicalFragment`). Then at ~1300 it sets the live fragment to `parsedNext.doc`, which was built
  from the older base (`updateYXmlFragment` when `incrementalFragmentUpdate`, else `replaceYXmlFragment`). A client
  update that reaches the live Y.Doc during those awaits is not seen by the re-check, and the write at ~1300 may remove
  it.

## Task
0. Confirm or refute each window from the code, citing lines. Say exactly which conditions reach it.
1. Write deterministic tests with a live collab client connected (use the existing collab test harness; the hook
   `__setBeforeCanonicalApplyHookForTests` in canonical-document.ts runs before the re-check, so add a test-only hook
   after the last await if you need one):
   (a) Window 2: during an AI `suggestion.add` (one `insert`, which uses the incremental update, and one `replace`),
       a client edit lands in the live Y.Doc after the base re-check. Assert the client's text survives in the live
       doc, in the row after the next persist, and after the document is reopened, or that the AI call returns a 409
       the AI can retry.
   (b) Window 1: an AI REST mutation updates the row and marks; then the client types before the next persist; then
       `persistDoc` and `onStoreDocument` run. Assert the typing survives the same three ways.
2. For each test that loses text, fix the cause in the smallest way that never discards live text. Examples, not
   requirements: in Window 2, re-check the live base synchronously right before the live write, with no await between
   check and write, and return 409 `STALE_BASE` on change; in Window 1, when the live fragment holds text the row lacks,
   apply only the marks diff and let the normal persist write the fragment.
3. Run `npm run build`, your tests, the collab tests you touched, `npx tsx src/tests/marks.test.ts` (3 known failures
   only) and `npm test`. Report honestly, with each test's exit code captured on its own statement.

## Commit
- With a fix: `fix(collab): an AI write never removes text a person is typing`.
- With no loss reproduced: commit the tests anyway, as `test(collab): guard live typing against canonical writes`, and
  say in the report why each window cannot lose text.
- Every factual claim in your report must come from code you read or a command you ran. Label anything else a guess.
- A run that ends without a commit is a failure.

<!-- Authored 2026-09-15 by Claude Opus 5 (CCc, COS) for Mike Wolf; Proof suggesting-mode work, fork eldrgeek/proof-sdk. -->
