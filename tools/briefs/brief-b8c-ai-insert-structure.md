# AI insert suggestions after B8: text lost in play-format paragraphs, paragraphs duplicated on Accept, table rows applied unreviewed

Your branch is based on `deploy/vps` in the fork (92941f2): upstream fb25787 plus every fix in flight, including B7 (a
connected page resolves suggestions through the Yjs marks map), C4/C4b (REST resolutions edit the live Y.Doc and stay
resolved; tombstoned marks are dropped everywhere) and B8 (commit 73555f2: `addSuggestionAsync` inserts an AI insert's
content into the markdown after the anchor via `mutateCanonicalDocument` with `strictLiveDoc`, and anchors the pending
mark on the inserted text).

Another worker (C5) is running on the same base. It changes quote anchoring across formatting, paragraph splitting for
block replacements, validation of unplaceable quotes in `addSuggestion`, and a target-drift accept regression. Keep your
changes inside the insert path (`kind === 'insert'` in `addSuggestionAsync`, the insert branch of `accept()`/`reject()`,
and insert drawing) where you can.

A third worker (C6) is running on the same base, in the collaboration layer (the share edit gate and hydration in
src/editor/index.ts, src/bridge/collab-client.ts). Stay out of those files.

## A previous run of this brief stopped without writing code
A first run ended after about five minutes with no commit and no changes. Its diagnosis, in its own words: "The failure
is in B8's whole-fragment rewrite: it reconstructs markdown, then replaces the live ProseMirror/Yjs fragment. The safer
insert-specific path can use y-prosemirror's incremental `updateYFragment` against a transformed ProseMirror document,
preserving hard breaks, inline formatting, links, and table structure while committing text and its mark atomically."
Verify that diagnosis against the code, then implement it, test it and commit. A run that ends without a commit is a
failure.

## Setup
- `ln -s /Users/mikewolf/Projects/proof-sdk/node_modules node_modules`; if anything is missing run
  `npm install --no-package-lock`. `npm run build`; `npm test`. Do not touch any live server.
- Known baseline failures (they also fail on untouched upstream fb25787; not yours): src/tests/marks.test.ts (3),
  share-event-poll-fallback-wiring, marks-accept-live-viewer-stability-regression, agent-edit-v2-live-viewer-regression,
  agent-edit-v2-live-structural-drift-regression, collab-onstore-drift-quarantine, share-server-startup.
- Also failing on this base, owned by C5: suggestion-anchor-validation ("Expected target drift accept to succeed, got 409").

## Facts the COS (Claude) verified on the live instance (build 92941f2, fresh documents, one person connected in Chromium)
All suggestions were added with `POST /documents/:slug/ops` `{"type":"suggestion.add","kind":"insert",…}`.
1. **Play-format paragraph: the text is lost and the projection goes stale.** Document
   `# Proof E2E\n\nERIC\\\nI think teh play is ready.\n\nDIANA\\\nThe second act needs one more scene.\n` (each speech is one
   paragraph: the character name, a hard break, then the speech — the How-To's whole format). Insert with quote
   `needs one more scene`, content ` AI insert words` → 200. The text never appeared in the page or in the server's
   markdown, and no mark appeared in the page, but the server kept a pending `insert` mark with no text behind it. The next
   two `suggestion.add` calls on that document (a replace and a delete) returned 409 `PROJECTION_STALE`. The same happened
   on a second document while the person kept typing: the orphan pending mark stayed on the server, and nothing could be
   accepted (docs 8bmmaumb, r9qvwd3a).
2. **The same kind of insert works in a paragraph without a hard break** (doc a54jh303): quote `Intro paragraph one.`,
   content ` AI inline words.` → the text appeared in the page drawn as a pending insert, Accept kept it once, the server
   stored it, and the projection stayed fresh.
3. **A paragraph added by insert is duplicated on Accept.** Quote `Closing paragraph.`, content `\n\nAnother AI paragraph.`:
   the new paragraph appeared with a pending mark covering `Another AI paragraph.` (content `\n\nAnother AI paragraph.`).
   Accept produced `Another AI paragraph.\n\nAnother AI paragraph.` and the server stored the paragraph twice. Guess to
   verify: the page's `accept()` compares the covered text with the raw content (which has the leading `\n\n`), sees a
   mismatch and takes the older insert-after path; B8's server path compares `normalizeQuote` of both, the page does not.
4. **A table row added by insert was applied without review and broke the table.** Table
   `| Name | Role |` / `| --- | --- |` / `| Eric | Writer |` / `| Diana | Director |`; quote `Director`, content
   `\n| Mike | Producer |`. The row was inserted at once with no pending mark in the page, and every row gained an empty
   third column (server markdown `| Name  | Role     |    |` …). The server spliced the content at the anchor's markdown
   end, which is inside the row, before its closing ` |`.

## Task
1. Make an AI insert work in any paragraph, including ones with hard breaks, emphasis, links and table cells: the text
   appears in the page and on the server under a pending insert mark, `/state` stays projection-fresh, and later
   `suggestion.add` calls succeed. Prefer computing the insertion in the document model (the way typed text is inserted
   into the live Y.Doc) over splicing markdown strings; if you keep splicing, prove it with each of those structures.
2. Block content (content containing a paragraph break, or a table row): insert at a block boundary — after the anchor's
   block (a paragraph → a new paragraph after it; a table cell → a new row after that row, with the table's column count)
   — as a visible, pending suggestion. Accept keeps it exactly once. Reject removes the whole inserted block, leaving no
   empty paragraph or row. If a structure cannot be represented as a pending suggestion, refuse at add time with a 4xx.
   `suggestion.add` must never change the document without leaving a pending suggestion behind.
3. The page's `accept()` must compare covered text and content the same way the server does, so accepting a new-style
   insert is mark-only.
4. Tests: (a) insert into a hard-break paragraph with a live client connected: text shown pending, `/state` fresh, a
   following `suggestion.add` returns 200; (b) paragraph insert: Accept keeps it once, Reject removes the paragraph;
   (c) table row insert: pending, Accept keeps the row with the right column count, Reject removes the row;
   (d) no `suggestion.add` ever changes the text without a pending mark.
5. Run `npm run build`, your tests, `npx tsx src/tests/marks.test.ts` (3 known failures only) and `npm test`. Report honestly.

## Commit
- `fix(suggestions): AI inserts work in every paragraph and at block boundaries, always as a pending suggestion`
- Every factual claim in your report must come from code you read or a command you ran. Label anything else a guess.
