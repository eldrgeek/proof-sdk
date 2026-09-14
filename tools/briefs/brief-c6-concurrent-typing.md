# Two people typing at the same moment: their characters interleave at the end of the document

Your branch is based on `deploy/vps` in the fork (92941f2): upstream fb25787 plus every fix in flight, including the
Editing/Suggesting switch, fix A and A2 (typed suggestion text was removed in the same instant by a forced re-render from
`kickCollabHydration()`; A2 added a guard for the local user's own typing), key-by-key typing integrity (B2a), B7 (a
connected page resolves suggestions through the Yjs marks map), C4/C4b and B8.

Two other workers are running on the same base: C5 (quote anchoring; src/editor/plugins/marks.ts and the server's
suggestion paths) and B8c (AI insert suggestions; the insert path in server/document-engine.ts and marks.ts). Stay in
the collaboration and hydration layer: the share edit gate, hydration checks and the y-prosemirror binding use in
src/editor/index.ts, and src/bridge/collab-client.ts. If you must touch marks.ts, keep it minimal.

## Setup
- `ln -s /Users/mikewolf/Projects/proof-sdk/node_modules node_modules`; if anything is missing run
  `npm install --no-package-lock`. `npm run build`; `npm test`. Never touch the live VPS server.
- Known baseline failures (they also fail on untouched upstream fb25787; not yours): src/tests/marks.test.ts (3),
  share-event-poll-fallback-wiring, marks-accept-live-viewer-stability-regression, agent-edit-v2-live-viewer-regression,
  agent-edit-v2-live-structural-drift-regression, collab-onstore-drift-quarantine, share-server-startup.
- Also failing on this base, owned by C5: suggestion-anchor-validation ("Expected target drift accept to succeed, got 409").

## Facts the COS (Claude) verified on the live instance (builds 0b3f8dd and 92941f2, fresh documents, headless Chromium)
The document is `# Proof E2E\n\nERIC\\\nI think teh play is ready.\n\nDIANA\\\nThe second act needs one more scene.\n`.
1. Two people open it. Mike places his caret after `play is ready.` (the ERIC paragraph); Eric places his after
   `one more scene.` (the last paragraph, which is the end of the document). Both type 17 characters at the same time,
   key by key, 60 ms apart: ` mike typed words` and ` eric typed words`.
2. Result, the same in Suggesting mode and in Editing mode, and the same with both people in one browser process or in
   two separate Chromium processes: both people's characters are interleaved at ONE place, the end of the document, for
   example `The  act needs one more scene. meirkiec  ttyyppeedd  wwoorrddss`. Nothing lands after `play is ready.`.
   Both pages and the server store the garbled text (in Editing mode the server's projection stays fresh). In
   Suggesting mode the suggestions also split into one per character. This predates B8 and C4b (seen on 0b3f8dd).
3. Typing one at a time does NOT garble. While Eric typed 4 characters at the end of the document, Mike's caret, which
   was not moving, stayed at position 43, and Mike's next keystroke landed correctly after `play is ready.` — in both
   modes. So a caret moves only while both people are typing.
4. Remote changes reach Mike's page as full-document replace steps (`replace[0-N]`, meta `y-sync$`), which is
   y-prosemirror's normal `_typeChanged` path with `restoreRelativeSelection`. For Eric's 4 keystrokes, Mike's page
   applied 91 collaboration transactions in Suggesting mode (mostly `marks$,y-sync$`) and 4 in Editing mode.
5. Suspects — guesses to verify, not conclusions: (a) `kickCollabHydration()` → `binding._forceRerender()`, reached from
   `updateShareEditGate()` when `isCollabHydratedForEditing()` sees the editor's text differ from the Y fragment's text.
   While two people type, the two texts differ for a moment, and y-prosemirror's `_forceRerender` replaces the whole
   document without restoring the relative selection, which would map a caret to the end of the document. A2's guard
   covers only the local user's own typing. (b) Any other whole-document replace dispatched without restoring
   selections. (c) The share edit gate toggling editability while someone is typing.

## Task
1. Find the cause in the code and with a reproduction: two clients typing at the same time at different positions.
   Fix it so each person's text lands at that person's own caret, in both modes, and so suggestions stay one per
   continuous insertion per author.
2. Make sure no path re-renders the whole document during live collaboration without restoring every local selection
   from relative positions, and that hydration checks never force a re-render merely because local or remote changes
   are still in flight.
3. Tests: an automated two-client test — two editors on one document through the real collab server, or the browser
   harness if the repo has one — that types into two paragraphs at the same time and asserts both texts land intact at
   their own positions, in Editing and in Suggesting mode. The probe that reproduces it against a running server is
   `/Users/mikewolf/Projects/.claude/worktrees/eager-kare-99ca0f/_estate/coo/workers/proof-2026-09-14/probes/two-reviewer-probe.mjs`
   (Playwright from /Users/mikewolf/Projects/playmaker/node_modules; env PROOF_DOC_URL=<tokenized document URL>,
   MODE=edit|suggest, SEPARATE_BROWSERS=1). You may run it against a local server you start yourself; never against the
   live VPS.
4. Run `npm run build`, your tests, `npx tsx src/tests/marks.test.ts` (3 known failures only) and `npm test`. Report honestly.

## Commit
- `fix(collab): concurrent typing lands at each person's caret`
- Every factual claim in your report must come from code you read or a command you ran. Label anything else a guess.
- A run that ends without a commit is a failure.
