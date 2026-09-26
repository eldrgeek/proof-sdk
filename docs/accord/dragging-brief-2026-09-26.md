# Brief: items can be dragged to new positions, step 6 of the build order (2026-09-26)

_Brief by Claude Opus 5.5 (CCc session 1997a29b, the reviewer) for Mike Wolf, 2026-09-26. Builder: Codex (seat `codex-builder`). Bead `ac-l71`. Branch `codex/accord-dragging`, cut at f89cb5a, which is the live release (step 4, shipped 2026-09-26)._

## Why

Mike and Claude agreed on the Accord "The Accord editor" (https://proof.vpsmikewolf.duckdns.org/d/yfbqrau4) on 2026-09-25; `docs/accord/rulings.md`, "The Accord editor (2026-09-25)". Its build order says:

> "6. Dragging items (point 8)."

Point 8, verbatim, as agreed:

> "Items can be dragged to new positions in the document. Dragging a folded section moves the whole section. A move is a proposed change like any other."

The same day Mike accepted all ten proposals of the Accord "Accords that act" (https://proof.vpsmikewolf.duckdns.org/d/wa8dhyv7; `docs/accord/rulings.md`, "Accords that act (2026-09-25)"). Three of them are this step. Verbatim:

> "Proposal 7. Mike reorders items by dragging them in the right-hand Review list. In an action Accord such as Waiting on Mike, the order is the order of priority, and the team works from the top."
>
> "Proposal 8. A move is a proposed change like any other (point 8 of the Accord "The Accord editor"). In Waiting on Mike, Mike is the only person who decides, so his own moves apply at once."
>
> "Proposal 9. View offers an outline: one line per item, with the same dragging. Dragging a folded section moves the whole section."

They came from Mike's own words: "the ability to reorder the list could be carried out by me dragging and dropping items in the right hand Review list, or presenting an outline list".

The Accord's definition, verbatim:

> **Item** — one unit of an Accord's text: a paragraph, a list entry, a heading or a table row.

Mike, 2026-09-25: "Let's make it work on desktop before going to mobile." Build and verify desktop first; the phone must not get worse than it is. Dragging on a phone is out of scope.

Two standing rulings bound this step (`docs/accord/rulings.md`, 2026-09-23): nothing folds, opens or moves unless the reader does it, and hover changes nothing. A drag handle that appears only under the pointer would be hover changing the page, so the handle's visibility rule below does not depend on hover.

## What the reviewer found (facts, checked 2026-09-26 on f89cb5a)

Read `src/shared/line-marks.ts`, `src/shared/bundles.ts`, `src/shared/folding.ts` and `src/shared/review-list.ts` headers first.

- **Nothing represents a move today.** There is no move operation, no move suggestion kind and no drag code for items (the only drag in `src` moves the PlayMaker review dialog by its header, `src/ui/playmaker-review.ts:273`). Suggestions are the inline text mark `proofSuggestion` (`src/editor/schema/proof-marks.ts:58-77`) with kinds `insert`, `delete`, `replace` and statuses `pending`, `accepted`, `rejected` (`src/formats/marks.ts:84-96`).
- **Items and lines.** `extractLines(doc)` (`src/shared/line-marks.ts:257-296`) makes one line per textblock and one per table row; a paragraph inside a list entry has kind `list_item`, but its `pos`/`nodeSize` are the inner paragraph's. `typedItemAt(doc, pos)` (`src/shared/typed-discussion.ts:54-71`) returns the item node around a position (table row, then list entry, then paragraph or heading), with `from`/`to` the node's before/after positions. Lines are anchored by `hash` + `occurrence` (`anchorForLine`, `resolveLineAnchor`, :298-342).
- **Sections.** `computeSections` (`src/shared/folding.ts:61-86`): every top-level heading opens a section that runs to the next heading of equal or higher rank, nested sections included, covering top-level blocks `[block, endBlock)`. A folded section's chip is `.pfold-chip` (`src/ui/folding.ts:298-358`). Folded text cannot be edited (`FOLDED_VIEW_POLICY.refuseEditsTouchingHidden`; the refusal is at `src/editor/index.ts:7005-7010`), and a move must not be refused for touching the hidden body of the section being moved.
- **Bundles are the one-decision group that exists.** `src/shared/bundles.ts` (`BUNDLE_POLICY`, `evaluateBundle`, `bundleIndex`): pending suggestions grouped under a title, accepted or rejected as one, stale when a member's line changed or a member was rejected. Stored in `document_bundles` (`server/db.ts:1447-1460`), created by `addToBundle` (`server/proof-extras.ts:142-191`) through `POST /api/agent/:slug/bundles` (`server/agent-routes.ts:4645`) or the `bundle` field of the suggest-* routes; the page cannot create one today. The page shows a bundle as one card in "Changes on this line" (`src/ui/reading-walk.ts:1514-1590`) and decides it with one batch and one Undo (`decideBundle`, :1617-1645, which then posts `/documents/:slug/bundles/:id/decision`, `server/routes.ts:2346`). Covered by `scripts/bundles-alts-check.mjs` and `src/tests/bundles-alts.test.ts`.
- **Accepting a delete removes text, not the block.** `accept` for `delete` runs `tr.delete` over the mark's range (`src/editor/plugins/marks.ts:3110-3234`); `reject` for an insert with `insertStructure: 'block'` or `'table_row'` removes the whole block or row (:3263-3269). The server's `prepareInsertSuggestion` (`server/document-engine.ts:2234-2359`) already lands multi-block content as whole blocks after an anchor block (`insertStructure 'block'`) and a `|` row as a table row. Check whether accepting a `delete` that covers a whole block's text leaves an empty block behind; a move must not leave one.
- **The rule from ac-lhc stands:** every way a pending suggestion ends is a recorded decision (`suggestionWithStatus`, `src/shared/suggestion-status.ts`), never a deletion. `server/collab-marks-guard.ts` restores a pending suggestion a client deletes from the marks map and forces a reload after 3 restores in 5 minutes.
- **Drops today.** `src/editor/editing-guard.ts:105-108` cancels `drop` inside `.ProseMirror` unless the person is Writing, and a drop that gets through is flattened into text suggestions by `wrapTransactionForSuggestions` (`src/editor/plugins/suggestions.ts:180-199`). ProseMirror's own drag moves the selection or a `draggable` node; only `image` is draggable in this schema. Do not build moves on ProseMirror's text drag.
- **The Review list** is computed by `reviewSurface` (`src/shared/review-list.ts:105-110`; `REVIEW_LIST_POLICY.order: 'document'`) and drawn by `renderIssues` (`src/ui/navigator.ts:263-313`) as `<li data-key><button class="anv-issue" data-line …>`. A row's `line` is a `DocLine` index; its title is the line text. Rows follow document order, and two checks assert the list never reorders by itself (`scripts/usability-acceptance-check.mjs:565`, `scripts/usability-s1-check.mjs:261`): those stay green, because a move changes the document, which the list then follows.
- **Who decides.** Roles are `viewer`, `commenter`, `editor`, `owner_bot` (`server/share-types.ts:3`); owners come from `documentOwnerActors` (`server/line-marks.ts:175-188`) and reach the page at `server/routes.ts:2166-2168`. Nothing lets a person's own change apply at once on the page; every page edit is a proposal (`EDIT_SESSION_POLICY.liveProposals`). The server applies a suggestion at once when it is created with `status: 'accepted'` (`addSuggestionAsync`, `server/document-engine.ts:2361`, :2562, :2692).
- **The View menu** is `menus()` in `src/editor/index.ts:4057` (View at :4099-4136). An Outline tab existed and was removed in step 2 (commit `2ae4d03`) because the right-hand panel holds only the open items (yfbqrau4: "The folded view replaces the Outline and Since you tabs, so the right-hand panel holds only the open items."), and `scripts/folded-view-check.mjs:91` asserts there is no Outline tab (no `[data-tab="outline"]`, `[data-tab="since"]`, `.anv-outline` or `.prw-since`). So the outline is NOT a tab in the right-hand panel, and it must not reuse those selectors. The phone ⋯ menu still labels an entry 'Review · Outline · Since you' (`src/editor/index.ts:4460`); correct it while you are there.
- **The page never jumps** (`src/editor/caret-anchor.ts`), and the scroll camera runs only for a cursor move the person caused (`SCROLL_CAMERA_POLICY.runsOn`).

## What to build

### 1. The rule, in a new policy module `src/shared/moves.ts`

`MOVE_POLICY` names every decision below that Mike's words do not fix, and pure functions that the editor, the server and the tests call:

- **What a drag moves** (`movingUnit(doc, item)`): the item itself (one paragraph, one whole list entry with its nested content, one heading, one table row). A heading whose section is folded moves its whole section: the heading and every block to the section's end. An unfolded heading moves alone.
- **Where it may land** (`dropTargets` / `isValidDrop`): between two top-level blocks; between two entries of a list, at the same nesting as the moved entry; between two rows of the same table (not above its header row). A table row never leaves its table; a whole section lands only between top-level blocks. Dropping a unit where it already is does nothing. Name each rule as a constant.
- **What a move is**: ONE proposal, decided with one Accept or one Reject and undone with one Undo, shown to everyone as one card that says what moves and where to ("Moves 'first words…' to after 'first words…'"). Build it on the bundle machinery (a bundle of the removal at the old place and the insertion at the new one, with a bundle kind that marks it a move) unless you find that impossible; if so, say why in your report before you build something else. Accepting it leaves the unit at the new place exactly once and nothing (no empty block) at the old place. Rejecting it leaves the document as it was. Both are recorded decisions, never deletions.
- **Mike's own moves in Waiting on Mike apply at once.** Generalise it as a per-document setting naming the actors whose own moves apply at once (for Waiting on Mike, `human:mw@mike-wolf.com`); the owner sets it through an owner route or API. Such a move is created already accepted, recorded as that person's decision, and it still has one Undo. For everyone else, and in every other Accord, a move is a proposal.

### 2. Dragging in the document (desktop)

- A drag handle in the left gutter (the gutter overlay, `renderGutter`, `src/ui/line-marks.ts:1466`) on the line the reader is on (the reading walk's focus line), and on every folded section's chip. It is visible without hovering. Dragging it shows where the unit would land (a drop line between items) and refuses invalid places. Letting go proposes the move (or applies it, for an actor whose moves apply at once).
- A keyboard way to move the focus item one slot up or down, as a proposal, for people who read by keys (J/K, A, Delete and S are already taken; check every key you pick against `src/shared/layout-panels.ts` and `src/ui/reading-walk.ts` and name it in the policy).
- The page does not jump during or after a move, except the ordinary scroll near the window's top and bottom edges while dragging.

### 3. Dragging in the Review list

Each row in the right-hand Review list can be dragged above or below another row. Letting go proposes moving that row's item (its section, when the row's line is a heading: in Waiting on Mike each item is a `###` section) to just before or after the target row's item. The list then follows the document's new order; it never reorders by itself.

### 4. The outline

View gets an entry "Outline" that shows the document as one line per item (headings, paragraphs, list entries and table rows, indented by nesting, each cut to one line), in the main text area, not in the right-hand panel. Clicking a line leaves the outline at that item. Its lines drag with the same rules: a heading line whose section is collapsed moves its section. Escape or the same View entry returns to the full text. Nothing about the outline is stored between visits unless you name a reason in the policy.

### 5. The server and the API

A move can be proposed through the agent API too (an AI proposes reordering Waiting on Mike): one route that takes the unit (by line, `{hash, occurrence}`, or `{ref, quote}` as `resolveAgentLineTarget` accepts, `server/line-marks.ts:665-700`) and the place, and returns the proposal. Document it in `docs/agent-docs.md`. `/state` shows a pending move as one open item.

## Checks (all yours to write; the reviewer runs the browser ones)

- **Unit suite `src/tests/moves.test.ts`**, wired into `npm test`: the policy, `movingUnit`, the drop rules, and two peers (the `pair()` fixture, `src/tests/review-history-fixture.ts:25`, with the real `wrapTransactionForSuggestions`): Alice's move reaches Bob as one pending proposal; accepting it leaves the unit at the new place once and nothing at the old place; rejecting it restores the document; Undo of each; a folded section moves whole; a move by an actor whose moves apply at once is applied, recorded, and undoable; a move whose unit Bob edits meanwhile is stale and refuses Accept, as bundles do.
- **Browser check `scripts/drag-check.mjs`**, both review styles at 1440 (and at 390: no handles, nothing broken), local server as the other checks do: drag an item with the mouse onto a drop line; Bob sees one move card and accepts it; the order changed and the old place is empty; Undo; drag a folded section; drag a Review list row; move by key; the outline's drag; a Waiting-on-Mike-style document where the owner's move applies at once; the page does not jump. Screenshots in `.preview/`.
- Every existing `scripts/*-check.mjs` and `npm test` stay green, in particular `bundles-alts-check`, `folded-view-check`, `usability-acceptance-check`, `usability-s1-check` and `click-edit-check`.

## Not in this step

Dragging on a phone; moving items between Accords; the team's reading of order as priority (ask-mike and the team work from the top once moves exist; that is estate work, not the editor's); action items and handing them to the team ("Accords that act", step 3).

## Report

Write your report to the `-o` file: what you built, each decision you named in `MOVE_POLICY` and why, what you ran and its result, and what you could not run in your sandbox (the browser checks; `listen EPERM` for the unit suites unless your launcher allowed network access). The reviewer commits your work as author `Codex <codex@openai.com>` with `Seat: codex-builder` and `Bead: ac-l71`, runs every check, and ships.
