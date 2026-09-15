# Two people typing in the same paragraph: the server's saved copy never gets both edits (a regression from B2a)

Your branch is based on `deploy/vps` in the fork (5b5c779): upstream fb25787 plus every fix in flight, including B2a
(key-by-key typing integrity), B7, C4/C4b/C4c, B8c, C5 and C6 (the page no longer overrides y-prosemirror's restored
selection after remote changes, and suggestion ids carry a per-browser nonce).

## Setup
- `ln -s /Users/mikewolf/Projects/proof-sdk/node_modules node_modules`; if anything is missing run
  `npm install --no-package-lock`. `npm run build`; `npm test`. Never touch the live VPS server.
- Known baseline failures (they also fail on untouched upstream fb25787; not yours): src/tests/marks.test.ts (3),
  share-event-poll-fallback-wiring, marks-accept-live-viewer-stability-regression, agent-edit-v2-live-viewer-regression,
  agent-edit-v2-live-structural-drift-regression, collab-onstore-drift-quarantine, share-server-startup.
- The two-browser test needs Playwright: run it as
  `PROOF_PLAYWRIGHT_PACKAGE_JSON=/Users/mikewolf/Projects/playmaker/package.json npx tsx src/tests/collab-concurrent-typing-browser.test.ts`.

## Facts the COS (Claude) verified
1. `npx tsx src/tests/collab-same-paragraph-race-regression.test.ts` exits 0 on upstream fb25787
   (`✓ same-paragraph concurrent collab typing persists each marker once`) and exits 1 on deploy/vps 92941f2 in two of
   two runs, and on C6 (94ca12f), with `Timed out waiting for canonical state contains both markers`.
2. `git bisect start --first-parent 92941f2 fb25787`, each step running only that test: the first bad commit is the
   merge 9202a08 "deploy: merge suggestion typing integrity (B2a)" (branch cursor/typing-integrity-175637, commits
   5116740 and 5ccd21a). Its first parent, c9e29f7 (the B2c merge), passes. B2a changed
   src/editor/plugins/authored-tracker.ts (it skips transactions marked `suggestions-wrapped`),
   src/editor/plugins/marks.ts (it stamps suggestion metadata such as `content` onto the `proofSuggestion` mark's attrs
   and keeps `content` in step while typing), and src/editor/plugins/suggestions.ts, and it added
   src/tests/suggestions-key-by-key.test.ts.
3. B2a's purpose must be kept: typing key by key in Suggesting mode produces one insert suggestion whose `content`
   equals the typed text, and per-character authored marks no longer make the server's rehydration fail
   (MARK_REHYDRATION_INCOMPLETE). suggestions-key-by-key.test.ts covers it, and live browser tests have relied on it all day.

## Task
1. Read the race test to see exactly what the two clients do and which "canonical state" it waits for. Find why B2a's
   changes stop that state from ever containing both markers, and prove the cause from the code or with a reduced
   reproduction.
2. Fix it so both collab-same-paragraph-race-regression and suggestions-key-by-key pass. Weaken neither test.
3. Run `npm run build`; the race test three times in a row (to show the pass is not timing luck); suggestions-key-by-key;
   the two-browser test (with the Playwright setting above); `npx tsx src/tests/marks.test.ts` (3 known failures only);
   and `npm test`. Report every exit code honestly.

## Commit
- `fix(collab): same-paragraph concurrent typing persists both edits again (B2a regression)`
- Every factual claim in your report must come from code you read or a command you ran. Label anything else a guess.
- A run that ends without a commit is a failure.
