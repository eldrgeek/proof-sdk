# AI block inserts: a paragraph at the end of a document lands no text, and accepting several AI inserts can quarantine the document

Your branch is based on `deploy/vps` in the fork (5b5c779): upstream fb25787 plus every fix in flight, including B7,
C4/C4b/C4c, C5, C6 and B8c (commit a122065: AI inserts are built in the ProseMirror model — inline after the quote, a
block after the anchor's block, a table row after the anchor's row with a column-count check — and applied to the live
Y.Doc with y-prosemirror's incremental `updateYFragment`; each mark records `insertStructure`).

B2d (commit b267658, not yet on this base) changes only the collab `onChange` handlers in server/collab.ts, so that
Y.Text-only client updates are no longer flagged as fragment edits. Stay out of those handlers.

## Setup
- `ln -s /Users/mikewolf/Projects/proof-sdk/node_modules node_modules`; if anything is missing run
  `npm install --no-package-lock`. `npm run build`; `npm test`. Never touch the live VPS server.
- Known baseline failures (they also fail on untouched upstream fb25787; not yours): src/tests/marks.test.ts (3),
  share-event-poll-fallback-wiring, marks-accept-live-viewer-stability-regression, agent-edit-v2-live-viewer-regression,
  agent-edit-v2-live-structural-drift-regression, collab-onstore-drift-quarantine, share-server-startup.
- Also failing on this base until B2d is merged: collab-same-paragraph-race-regression.
- The two-browser test needs `PROOF_PLAYWRIGHT_PACKAGE_JSON=/Users/mikewolf/Projects/playmaker/package.json`.

## Facts the COS (Claude) verified on the live instance (build 5b5c779, fresh documents, one person connected in Chromium)
The document is `# Block test\n\nIntro paragraph one.\n\n| Name | Role |\n| --- | --- |\n| Eric | Writer |\n| Diana | Director |\n\nClosing paragraph.\n`.
The AI adds suggestions with `POST /documents/:slug/ops` `suggestion.add`, kind `insert`; the person accepts or rejects
them with `window.proof.markAccept(id)` / `markReject(id)`.
1. **Paragraph alone: no text lands.** Quote `Closing paragraph.` (the document's last block), content
   `\n\nAnother AI paragraph.` → 200. The server lists one pending insert, but `Another AI paragraph` is in neither the
   page nor the server's markdown, and the projection is fresh (doc 3b0ux1ye). That is a pending mark with no text — the
   failure B8c was meant to remove, here for a block inserted after the last block of the document.
2. **Table row alone works.** Quote `Director`, content `\n| Mike | Producer |`: the page shows the pending row, Accept
   keeps it, the server stores the row once (5 rows, 2 columns each), the projection is fresh and the document reopens
   in about a second (doc wrzljxto). **Inline text alone works** the same way (quote `Intro paragraph one.`, content
   ` AI inline words.`; doc jn70182i).
3. **All three in one document, accepted one after another, quarantined it.** Order: inline, then paragraph, then table
   row. In the page all three appeared pending, each Accept returned true, and the page showed the right blocks. But the
   server logged `[collab] auto quarantined slug`; `/state` then reported `readSource: yjs_fallback`,
   `projectionFresh: false`, `mutationReady: false`, `repairPending: true`; all three suggestions were still pending on
   the server; and in the fallback markdown the original table rows were padded to about 130 characters per column while
   the new row was unpadded. Reopening fails: HTTP 500 and `[initFromShare] Failed: Error: Unable to build collab session`
   (doc ecbvkrlr).
4. **Rejecting the same three inserts works:** each whole insertion is removed, with no empty paragraph or row left, the
   projection stays fresh and the document reopens (doc rdq9nwvj).
5. **Fact 3 repeats.** On a second fresh document (rlgcmxjg), the same three inserts accepted in the same order gave the
   same result: each Accept returned true in the page, then the server logged one auto-quarantine, `/state` reported
   `yjs_fallback`, not fresh, `mutationReady: false`, `repairPending: true`, all three inserts still pending, and
   reopening failed with `Unable to build collab session`. Two runs out of two.

## Task
1. Find why a block insert after the last block of a document leaves no text, and fix it so the text lands and shows as
   pending in a connected page and on the server.
2. Find what divergence makes the server auto-quarantine the document when several AI inserts are accepted (read the
   quarantine decision — `maybeQuarantineStaleOnStoreReload` and the persist/projection paths in server/collab.ts — and
   the accept path for `insertStructure` marks), and fix the cause. Accepting suggestions must never quarantine a document.
3. Say what makes a quarantined document return "Unable to build collab session" (HTTP 500), and whether it can recover.
   Fix it only if the fix is small and safe; otherwise report it.
4. Tests, each with a live collab client connected: (a) a paragraph insert after the last block lands and shows pending;
   (b) the combined sequence — inline, paragraph, table row — accepted one after another: no quarantine, projection fresh,
   each insertion stored exactly once, table columns intact, and the document reopens; (c) the same sequence rejected
   leaves the original document.
5. Run `npm run build`, your tests, `npx tsx src/tests/marks.test.ts` (3 known failures only) and `npm test`. Report honestly.

## Commit
- `fix(suggestions): AI block inserts always land, and accepting several never quarantines the document`
- Every factual claim in your report must come from code you read or a command you ran. Label anything else a guess.
- A run that ends without a commit is a failure.
