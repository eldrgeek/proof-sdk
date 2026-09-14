# AI suggestions near formatting: wrong anchors duplicate text, paragraph breaks are refused, unplaceable suggestions vanish

Your branch is based on `deploy/vps` in the fork (92941f2): upstream fb25787 plus every fix in flight, including B7 (a
connected page resolves suggestions through the Yjs marks map), C4 (REST resolutions edit the live Y.Doc), B8 (an AI
insert suggestion puts its text into the document after the anchor and anchors the pending mark on it; older
quote-anchored inserts get a widget; accepting a delete cleans up an adjacent space) and C4b (tombstoned marks are dropped
from collab writes, projections and canonical syncs; a page removes suggestions that an authoritative marks snapshot no
longer has). Build on those behaviours; do not undo them. C4b's page change matters for task 3 below: "a page must never
delete a suggestion it cannot place" must not re-open the resurrection C4b fixed.

Another worker (B8c) is running on the same base. It changes the insert path: `kind === 'insert'` in
`addSuggestionAsync`, the insert branch of `accept()`/`reject()`, and how inserts are drawn. Stay out of those where you
can; if you must touch `addSuggestion`, keep the change small and separate.

## A previous run of this task was interrupted
A worker started this exact task on the same base and was stopped before it committed, built or tested anything. Its
uncommitted diff (server/anchor-resolver.ts, server/document-engine.ts, src/editor/plugins/marks.ts; 196 insertions,
26 deletions) is saved at
`/Users/mikewolf/Projects/.claude/worktrees/eager-kare-99ca0f/_estate/coo/workers/proof-2026-09-14/c5-partial.patch`.
Read it first. If it is sound, apply it with `git apply` and continue from it; keep what is correct, fix what is not,
and say in your report which parts you kept.

## Setup
- `ln -s /Users/mikewolf/Projects/proof-sdk/node_modules node_modules`; if anything is missing run
  `npm install --no-package-lock`. `npm run build`; `npm test`. Do not touch any live server.
- Known baseline failures (they also fail on untouched upstream fb25787; not yours): src/tests/marks.test.ts (3),
  share-event-poll-fallback-wiring, marks-accept-live-viewer-stability-regression, agent-edit-v2-live-viewer-regression,
  agent-edit-v2-live-structural-drift-regression, collab-onstore-drift-quarantine, share-server-startup.

## Facts the COS (Claude) verified on the live instance (build 0b3f8dd, fresh documents, one person connected in Chromium)
All suggestions were added with `POST /documents/:slug/ops` `{"type":"suggestion.add","kind":"replace",…}` and all
returned 200 `success: true`; the person then accepted each with `window.proof.markAccept(id)`.

1. **A quote that starts in plain text and runs into a bold word anchors on part of itself.** Paragraph
   `The **Format** line sets the style for the play.`; quote `The Format line sets the style`, content
   `The **Format** line sets the house style`. The server stored the full quote and listed it pending, but the page's
   mark covered only `Format line sets the style` (the leading `The ` was dropped; the end was right). Accept produced
   `The The **Format** line sets the house style for the play.` — duplicated text, stored on the server (doc c9nzh259;
   reproduced identically on build 92941f2, doc et76ouh9).
2. **Quotes that stay inside one run, or that start at a formatted word, anchor exactly** (docs ui144ct8, k0av4p9o):
   `line sets the style` (plain run after a bold word); `Cue name comes` (starts at bold `Cue`); the whole paragraph
   `Today: the editor keeps line breaks after a name.` (starts at bold `Today:`); and the whole paragraph
   `Fixed on 14 September. The caret lands in the new line after Enter.`, which starts at a bold label AND crosses into
   bold `new` in the middle. So the failure in fact 1 needs a quote that STARTS in plain text with a formatted run
   later inside it; crossing boundaries in the middle is fine once the quote starts at a formatted run. Accepting
   `Cue name comes` → `Cue name always comes` dropped the bold on `Cue`; that is expected, because the content had no `**`.
3. **A replace whose content adds a paragraph break inside a paragraph is refused.** Paragraph
   `Each **Scene** heading starts a new scene in the play.`; quote `a new scene in the play.` (the paragraph's last
   words), content `a new scene in the play.\n\nA new AI paragraph.`. The mark anchored exactly, but `markAccept`
   returned false and the suggestion stayed pending. Replacing a WHOLE paragraph with `that paragraph\n\nnew paragraph`
   works (doc ui144ct8, and a table test doc u4ru6ot3).
4. **A quote written in markdown form never anchors, and the suggestion then disappears.** Quotes
   `[the guide](https://example.com/guide)` (doc c9nzh259) and `| Diana | Director |` (a table row, doc u4ru6ot3) returned
   200 and were listed pending on the server, but no mark appeared in the page, and after the page's later marks syncs the
   server listed nothing pending: the page deleted suggestions it could not place, with no error anywhere.
5. `addSuggestion` (server/document-engine.ts, about line 1715) accepts a quote if either the normalized markdown or the
   normalized plain text contains it, and stores `startRel`/`endRel` as `char:` offsets from `findQuoteAnchorInMarkdown`
   (`strippedStart`/`strippedEnd`). The page resolves the mark through `applyRemoteMarks` (src/editor/plugins/marks.ts).

## Task 0 (do this first): a regression that appears only when B8 and C4b are combined
- On this base (merge commit 92941f2 = B8 + C4b on 0b3f8dd), `npx tsx src/tests/suggestion-anchor-validation.test.ts`
  fails every time (two of two runs) at about line 411: `Expected target drift accept to succeed, got 409`.
- The case: a document `# Title\n\nRepeat\n\nContext target\nRepeat`; `suggest-replace` with
  `target: { anchor: 'Repeat', occurrence: 1 }` → 200; `db.updateDocumentAtomic` then inserts another `Repeat` earlier
  (the target drifts); `executeDocumentOperation(slug, 'POST', '/marks/accept', { markId })` must return 200 with
  markdown `# Title\n\nRepeat\n\nRepeat\n\nContext target\nChanged`, but returns 409.
- The same test passes on upstream fb25787, on B8 alone (73555f2) and on C4b alone (60cfb91). So it comes from how B8's
  accept-path changes (`buildAcceptedSuggestionMarkdown` / `buildAcceptedSuggestionMarkdownFromSelection` in
  server/document-engine.ts, and `accept()` in src/editor/plugins/marks.ts, which the server's rehydration also uses)
  combine with C4b's tombstone changes (`removeResurrectedMarksFromPayload` in server/db.ts now removes every unexpired
  tombstoned id except resolved comments; `dropTombstonedMarks` in server/collab.ts).
- Find the cause, report the 409's `code`, and fix it without undoing either B8's or C4b's behaviour.
- **Correction, added after this brief was dispatched (2026-09-14):** the claim above that the test passes on upstream
  fb25787, on B8 alone and on C4b alone was wrong. The COS printed each exit code after a command substitution
  (`echo "$(git log …): rc=$?"`), so every run showed 0. Rerun with the exit code saved at once, the test fails the same
  way on upstream fb25787, on B8 alone (73555f2) and on C4b alone (60cfb91). It is a pre-existing upstream failure, not
  an interaction. C5's closest-context fallback in server/anchor-resolver.ts (commit 9559eac) fixes it.

## Task
1. Make a quote that spans formatting boundaries anchor on exactly the quoted visible text, wherever it starts and ends.
   Find why the start moved in fact 1 (the `char:` offsets, the plain-text/markdown mapping, or the page's quote
   search), fix the cause, and make Accept replace exactly that range.
2. Make a replace (and a delete, if the same path applies) whose content contains block breaks work when the quote covers
   part of a paragraph: split the paragraph at the range and insert the parsed blocks, keeping the rest of the paragraph
   and its formatting. Refuse only where the result would be invalid, and then refuse at `suggestion.add` time (see 3),
   not silently at Accept.
3. Unplaceable suggestions must fail loudly and never vanish. At `suggestion.add`: if the quote cannot be mapped to
   visible document text (markdown-form quotes included), either map it (strip the markdown syntax and anchor the visible
   text) or return a 4xx with a clear code and message; never 200. In the page: a suggestion that cannot be anchored must
   never be removed from the shared marks map or the server by the page's own sync; keep it stored and log it once.
4. Tests: (a) the fact 1 case anchors on the full quote and Accept gives `The **Format** line sets the house style for the
   play.`; (b) the fact 3 case accepts and yields two paragraphs with the first paragraph's bold intact; (c) a markdown-form
   link quote either anchors on the link text or is refused with 4xx at add time; (d) a page that cannot anchor a stored
   suggestion leaves it in the server's marks after its marks sync; (e) suggestion-anchor-validation passes.
5. Run `npm run build`, your tests, `npx tsx src/tests/marks.test.ts` (3 known failures only) and `npm test`. Report honestly.

## Commit
- `fix(suggestions): anchor quotes across formatting exactly, split paragraphs on block replacements, never drop unplaceable suggestions`
- Every factual claim in your report must come from code you read or a command you ran. Label anything else a guess.
