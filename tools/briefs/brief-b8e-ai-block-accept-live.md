# B8e: accepting several AI block inserts from a connected page still quarantines the document (live, after B8d)

Your branch is based on 00c0e15 in the fork (branch `deploy/vps`, now live on the VPS): upstream fb25787 plus B7,
C4/C4b/C4c, C5, C6, B8c, B2d, B2e and B8d. B8d (commit 6c977bc) set out to make AI block inserts land and to stop
accepts from quarantining a document. Its first half works live. Its second half does not: its local test passes, but
the live sequence below still quarantines the document.

Stay out of the collab `onChange` handlers (B2d/B2e). A separate worker (C7) is adding tests around
`resolveOnStoreConflict` and `mutateCanonicalDocument`; do not change those two unless this bug needs it, and say so.

## Setup
- `ln -s /Users/mikewolf/Projects/proof-sdk/node_modules node_modules`; if anything is missing run
  `npm install --no-package-lock`. `npm run build`; `npm test`. Never touch the live VPS server.
- Known baseline failures (they also fail on untouched upstream fb25787; not yours): src/tests/marks.test.ts (3),
  share-event-poll-fallback-wiring, marks-accept-live-viewer-stability-regression, agent-edit-v2-live-viewer-regression,
  agent-edit-v2-live-structural-drift-regression, collab-onstore-drift-quarantine, share-server-startup.
- The browser tests need `PROOF_PLAYWRIGHT_PACKAGE_JSON=/Users/mikewolf/Projects/playmaker/package.json`.

## Facts the COS (Claude) verified on the live instance (build 00c0e15, fresh document lsyaxh32, one person in Chromium)
The document is `# Block test\n\nIntro paragraph one.\n\n| Name | Role |\n| --- | --- |\n| Eric | Writer |\n| Diana | Director |\n\nClosing paragraph.\n`.
1. The AI added three inserts with `POST /documents/:slug/ops` `suggestion.add`, kind `insert`, each → 200: quote
   `Intro paragraph one.` content ` AI inline words.`; quote `Closing paragraph.` content `\n\nAnother AI paragraph.`;
   quote `Director` content `\n| Mike | Producer |`. All three showed in the page as pending, in the right places.
   (Before B8d the paragraph after the last block landed no text; now it does.)
2. The person accepted them one after another from the page, with `window.proof.markAccept(id)` (inline, then
   paragraph, then table row). Each call returned true, and the page showed the right blocks after each.
3. The server then logged, in order:
   - `[collab] blocked legacy Yjs reseed during active live collab lease` (source `read_persisted_doc_state_async`,
     `blockedReason: recent_live_collab_lease`, projectionHealth healthy);
   - three seconds later, `[collab] blocked unsafe projection write; keeping canonical DB projection`,
     reason `growth_multiplier_exceeded`, baselineChars 201, candidateChars 1708, maxGrowthMultiplier 8;
   - at the same moment, `[collab] auto quarantined slug`, reason `projection_guard_repeated_blocker`, details
     source `repair`, guardReason `growth_multiplier_exceeded`, count 2 within windowMs 60000, reasons
     `stale_projection`, `projection_stale`.
4. `/state` afterwards: `readSource: yjs_fallback`, `projectionFresh: false`, `mutationReady: false`,
   `repairPending: true`. The server still lists all three inserts as pending, although the page accepted them.
5. In the fallback markdown the table's columns are padded to about 131 and 135 characters. Those widths differ by 4,
   which is len("Producer") − len("Mike"), the two cells of the AI's new row. A guess to check first: the markdown
   serializer lays out the table while suggestion span markup (`<span data-proof=...>` around each cell of the new
   row) is still in the cells, and the spans are stripped afterwards, leaving the padding. That would make the
   projection about 8.5 times larger and trip the growth guard.
6. Reopening the document then times out in the page (the probe's open waits 30 s for an editable editor).
7. The same sequence on build 5b5c779 failed the same way twice before B8d. The same three inserts rejected instead
   of accepted work on 00c0e15: each insertion is removed and the server is fresh (doc 08n7x87a). A table-row insert
   accepted on its own worked on 5b5c779.

## Task
1. Reproduce fact 3 in a test that accepts the way the page does: a connected client (a real browser page, or a
   client driving the same `markAccept` path through the Yjs marks map), accepting inline, then paragraph, then table
   row, about one second apart. Say why B8d's test did not catch it.
2. Find and fix the cause, so that (a) accepted status reaches the server's marks; (b) the projection of a table that
   contains or contained a suggestion is laid out on visible text only, with no padding from span markup; (c) accepting
   suggestions can never trip the growth guard or quarantine a document. If fact 5's guess is wrong, say what is true.
3. Check the same padding question for a pending (not yet accepted) table-row insert, and fix it the same way if it
   pads.
4. Tests: the combined accept sequence with a connected client — no quarantine, projection fresh, each insertion
   stored exactly once, table columns padded only to their visible text, and the document reopens. Keep B8d's tests
   passing.
5. Run `npm run build`, your tests, `npx tsx src/tests/marks.test.ts` (3 known failures only) and `npm test`. Report
   honestly, with each test's exit code captured on its own statement.

## Commit
- `fix(suggestions): accepting AI block inserts from a live page never quarantines the document`
- Every factual claim in your report must come from code you read or a command you ran. Label anything else a guess.
- A run that ends without a commit is a failure.

<!-- Authored 2026-09-15 by Claude Opus 5 (CCc, COS) for Mike Wolf; Proof suggesting-mode work, fork eldrgeek/proof-sdk. -->
