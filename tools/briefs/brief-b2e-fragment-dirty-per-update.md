# B2d broke C4's reconnect-after-invalidate case: decide per update whether the rich-text fragment changed

Your branch is based on `integ/with-b2d` in the fork (13a37fe): deploy/vps 5b5c779 (upstream fb25787 plus B7, C4, C4b,
C4c, B8c, C5 and C6) with B2d (commit b267658) merged on top. Another worker (B8d) is changing the AI insert path in
server/document-engine.ts, server/canonical-document.ts and src/editor/plugins/marks.ts; stay out of those.

## Setup
- `ln -s /Users/mikewolf/Projects/proof-sdk/node_modules node_modules`; if anything is missing run
  `npm install --no-package-lock`. `npm run build`; `npm test`. Never touch the live VPS server.
- Known baseline failures (they also fail on untouched upstream fb25787; not yours): src/tests/marks.test.ts (3),
  share-event-poll-fallback-wiring, marks-accept-live-viewer-stability-regression, agent-edit-v2-live-viewer-regression,
  agent-edit-v2-live-structural-drift-regression, collab-onstore-drift-quarantine, share-server-startup.
- The two-browser test needs `PROOF_PLAYWRIGHT_PACKAGE_JSON=/Users/mikewolf/Projects/playmaker/package.json`.

## Facts the COS (Claude) verified
1. On 5b5c779 (before B2d), `src/tests/collab-rest-suggestion-live-persistence-regression.test.ts` passes and
   `src/tests/collab-same-paragraph-race-regression.test.ts` fails (`Timed out waiting for canonical state contains both
   markers`). The race failure was bisected to the B2a merge; it passes on upstream fb25787.
2. B2d removed `ensureFragmentEditTracking(data.document).dirty = true` from the three collab `onChange` handlers in
   server/collab.ts (startCollabRuntime, startCollabRuntimeEmbedded, startCollabRuntimeAttached). Its reason: every
   client update, including Y.Text-only updates to the markdown mirror, was being flagged as a fragment edit, and the
   projection refresh then restored a stale fragment over the converged edits.
3. With B2d merged (13a37fe): the race test passes (two of two runs here, three of three in B2d's own run), and
   suggestions-key-by-key and the two-browser test pass. But the live-persistence regression now fails:
   `Timed out waiting for canonical edit after reconnect during clearing invalidate`, thrown from
   `assertReconnectDuringClearingInvalidatePersists` (about line 921).
4. C4's report (commit 69e051d) explained why that line mattered: "the first post-reconnect client update needed
   explicit fragment-dirty marking: Hocuspocus can hand onChange a different Y.Doc reference than onLoadDocument, so the
   listener otherwise misses that first transaction and persists Yjs without refreshing the projection." That flag is
   the line B2d removed.
5. **It is a real regression, not load.** Rerun one after the other on an otherwise quiet machine: on 13a37fe (with
   B2d) the live-persistence test failed again with the same reconnect timeout (two failures out of two runs); on
   5b5c779 (without B2d) it passed, `✓ REST suggestion resolution preserves later live persistence`.

## Task
1. Make both tests pass by deciding, per update, whether the rich-text fragment changed — instead of never (B2d) or
   always (before B2d). For example: attach the `afterTransaction` fragment tracker to whatever Y.Doc Hocuspocus hands
   `onChange` when it is not tracked yet, or inspect whether the update touched the `prosemirror` XmlFragment. Prove the
   choice from the code.
2. Keep both reasons intact: a Y.Text-only update must never be treated as a fragment edit (B2d), and the first update
   after a reconnect must refresh the projection (C4).
3. Run `npm run build`; the race test three times; the live-persistence regression twice; suggestions-key-by-key; the
   two-browser test (with the Playwright setting); `npx tsx src/tests/marks.test.ts` (3 known failures only); and
   `npm test`. Report every exit code.

## Commit
- `fix(collab): classify fragment edits per update, so same-paragraph typing and reconnect-after-invalidate both persist`
- Every factual claim in your report must come from code you read or a command you ran. Label anything else a guess.
- A run that ends without a commit is a failure.
