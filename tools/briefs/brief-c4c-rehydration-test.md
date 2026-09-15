# Update proof-mark-rehydration.test.ts to C4's reject contract (a REST reject no longer forces open pages to reload)

Your branch is based on `deploy/vps` in the fork (92941f2): upstream fb25787 plus every fix in flight, including C4
(commit 69e051d) and C4b. Other workers are changing server/document-engine.ts, src/editor/plugins/marks.ts and the
collaboration layer in src/editor/index.ts at the same time. This task is test-only: change
src/tests/proof-mark-rehydration.test.ts and nothing else, unless the test exposes a real bug — then report it instead of
working around it.

## Setup
- `ln -s /Users/mikewolf/Projects/proof-sdk/node_modules node_modules`; if anything is missing run
  `npm install --no-package-lock`. `npm run build`; `npm test`. Never touch the live VPS server.
- Known baseline failures (they also fail on untouched upstream fb25787; not yours): src/tests/marks.test.ts (3),
  share-event-poll-fallback-wiring, marks-accept-live-viewer-stability-regression, agent-edit-v2-live-viewer-regression,
  agent-edit-v2-live-structural-drift-regression, collab-onstore-drift-quarantine, share-server-startup,
  suggestion-anchor-validation (target-drift accept 409; fixed by C5, which is not on this base yet).

## Facts the COS (Claude) verified
1. `npx tsx src/tests/proof-mark-rehydration.test.ts` exits 1 on this base, and on this base plus C5, with
   `Error: Expected split suggestion reject to bump access_epoch so stale collab rooms must reload` (the assertion is at
   about line 461). It exits 0 on upstream fb25787.
2. C4 removed that behaviour on purpose. Before C4, `updateSuggestionStatusAsync` (server/document-engine.ts) bumped
   `access_epoch` and called the clearing `invalidateCollabDocument` after a REST reject. On the live server that rebuilt
   the shared document, and a person who had it open lost every edit they made afterwards (no later update was stored).
   C4 instead applies the reject to the live Y.Doc, with no epoch bump and no clearing invalidate.
   `src/tests/collab-rest-suggestion-live-persistence-regression.test.ts` covers the new contract: after a REST reject
   or accept, a reconnected client's later edits persist and `/state` stays fresh.

## Task
1. Replace the old expectation in proof-mark-rehydration.test.ts with C4's contract for that case: after the REST
   reject of the split suggestion, `access_epoch` is unchanged, the suggestion is gone from the stored marks and from the
   live Y.Doc's marks map, the document text is what a reject should leave, and nothing forces connected clients to
   reload. Keep every other assertion in the file as it is. Say in a comment why the expectation changed.
2. Run the test (it must exit 0), `npx tsx src/tests/marks.test.ts` (3 known failures only) and `npm test`. Report honestly.

## Commit
- `test(rehydration): expect a REST reject to apply live without an access-epoch bump (C4 contract)`
- Every factual claim in your report must come from code you read or a command you ran. Label anything else a guess.
- A run that ends without a commit is a failure.
