# Brief: the folded view, step 2 of the build order (2026-09-24)

_Brief by Claude Opus 5.5 (CCc session 1997a29b, the reviewer) for Mike Wolf, 2026-09-24. Builder: Codex (seat `codex-builder`). Bead `ac-2a8`. Branch `codex/accord-folded-view`, cut at c03b4cd: step 1 (b6577db, live) plus step 3 (click-to-edit as live proposals, commits bd53810 to c03b4cd, not yet live). Build on step 3 as it stands; it ships first._

## Why

Mike and Claude agreed on "The Accord rules" (https://proof.vpsmikewolf.duckdns.org/d/gfmd0z5p; `docs/accord/rulings.md`, "The Accord rules (2026-09-24)"). Mike then described how the editor should work, in the Accord "The Accord editor" (https://proof.vpsmikewolf.duckdns.org/d/yfbqrau4). Its build order, which Mike accepted, says:

> "2. The folded view, with the control that shows the whole Accord."

Mike's own point 9, verbatim:

> "By default you see only the top-level folds and the items that are open, but you can change the view to the entire document or unfold parts of the document."

Mike also accepted this idea in the same session (it is in the Accord under "Other ideas"):

> "The folded view replaces the Outline and Since you tabs, so the right-hand panel holds only the open items."

Claude proposed two more sentences for point 9. They are still an open proposal in that Accord, but they are the only concrete description of the control, so build them, as policy constants that a later ruling can switch off in one line:

> "One line at the top counts the open items and the items in accord, next to a control that shows the whole Accord. The view does not change while you read; it starts folded on your next visit."

The Accord's definitions, verbatim:

> **Item** — one unit of an Accord's text: a paragraph, a list entry, a heading or a table row.
> **Open item** — an item that holds an open issue for you.
> **Top-level folds** — the Accord's top sections, each shown as its heading only. Unfolding one shows its items.

## Terms used in this brief

- **Line**: one entry of `extractLines` (`src/shared/line-marks.ts`). A line is an item: a paragraph, a list entry, a heading, a table row or a code block.
- **Open for you**: the lines in the right-hand list's "Needs you" scope (`reviewViews()['needs-you']`).
- **Open**: the lines in its "All open" scope (`reviewViews()['all-open']`): open for anyone on the team. This includes your own proposals that wait on someone else.
- **In accord**: every other line.
- **Shown**: a line the folded view keeps visible inside a folded section.
- **Title**: the first line of the document, when it is a heading and no other heading has the same level or a higher one (a lower number). Most Accords start with one `#` title over `##` sections.
- **Top-level section**: a section at the highest heading level that remains once the title is set aside. In a document with a `#` title and `##` sections, the `##` sections.
- **Opening**: the lines between the title (or the start of the document) and the first top-level heading.
- **Visit**: one page load. A reload is a new visit.

## What to build

### 1. The folded view is how every visit starts

- On every visit, once the document and its open items have loaded, the page shows the folded view:
  - the title, if there is one;
  - every top-level heading;
  - every open line (the "All open" scope, so your own proposals that wait on others show too);
  - for each open line inside nested sections, the headings on its path, so the reader sees where it sits;
  - for an open list entry inside a nested list, its parent entries, for the same reason.
- Everything else is hidden: the opening, and the rest of each top-level section.
- Each run of hidden lines is drawn as one thin rule where the lines were. The rule says what it stands for, for example "4 items in accord", or "4 items, 1 open" when a hidden line became open during the visit. Clicking the rule shows exactly those lines and nothing else. A rule that stands for a whole section's body unfolds that section.
- A shown list entry keeps its own number: entry 5 of an ordered list still reads "5.", not "1.". A table never shows part of a row, and a shown row brings the table's header row with it.
- Until the open items have loaded, the page shows no document text, so nothing collapses under the reader. If they have not loaded after `FOLDED_VIEW_POLICY.loadTimeoutMs` (5 s), show the whole Accord and say so in the count line.
- The fold state is no longer stored between visits. Stop reading and writing the `proof:fold:` localStorage keys. This replaces "Sections stay as the reader left them" (2026-09-23), which the Accord rules supersede.

### 2. The view holds still while the reader reads

- During a visit, the view changes only by the reader's own action: a rule, a heading's disclosure control, the whole-Accord control, or a jump to a line (the right-hand list, J and K in that list, a link, Find).
- A line that stops being open during the visit (accepted, rejected or withdrawn) stays shown until the next visit.
- A line that becomes open during the visit, for example a remote proposal inside a hidden run, stays hidden. The right-hand list gets its row, the counts update, and its rule's label says "1 open".
- A jump to a hidden line shows that line (and its path headings), without unfolding its section. This replaces today's `FoldingUI.reveal`, which unfolds every folded ancestor.
- A line the reader creates or edits during the visit is shown. For example, Enter at the end of a shown item makes a new item, and it must not vanish into a hidden run.
- Keep shown lines by position mapped through each transaction, not by text hash, so an item stays shown while anyone edits it.

### 3. Editing never reaches hidden text

Step 3 made a click in the text place the caret. So:

- The caret never lands in a hidden line. ArrowUp and ArrowDown across a rule go to the next shown line.
- An edit from the reader's typing, paste, cut or drop that would change a hidden line is refused. Show one line ("That would change hidden text. Show it first.") and change nothing. Examples: Backspace at the start of a shown item that follows a rule (which would join it to the hidden item before it); Delete at the end of a shown item before a rule; a selection from one shown item to another across a rule, then typing or Delete.
- Never refuse a remote change, an accept or reject (a bundle may touch hidden members), an undo or a redo.

### 4. One line at the top, and the control that shows the whole Accord

- The first line of the page column, above the title, is the count line. Examples:
  - "6 open for you · 2 waiting on others · 50 in accord" and the control "Show the whole Accord";
  - "In accord: all 58 items" when nothing is open for anyone;
  - leave out a zero middle part ("6 open for you · 52 in accord").
  - Count lines, as the Terms above define them. "Waiting on others" is Open minus Open for you.
- The counts update live. The view does not.
- "Show the whole Accord" shows every line. The control then reads "Show only open items". That control returns to the folded view, recomputed from the lines open at that moment: it is the reader's own action, so the view may change.
- The same toggle is in the View menu and in the phone's ⋯ menu. It replaces "Collapse all sections" and "Expand all sections" there.
- The count line replaces the line-mark header (`OpenViewUI`'s "honest header", `accordHeader`), whose clauses describe line marks, which the Accord rules retire.
- The agreed copy (the Accord view, `aov-in-accord`) is unchanged: it shows the whole Accord and no count line.

### 5. Unfolding parts of the document

- Each heading keeps its disclosure control (`.pfold-chip`). On a folded section it unfolds the whole section. On an unfolded section it folds the section back to its heading and its shown lines, with rules for the rest.
- The chip's badge counts the open lines in the section (today it counts pending changes; use Open).
- Fold actions stay on the one Undo stack, as today.

### 6. The right-hand panel holds only the open items

- Remove the Outline and Since you tabs, their panes, their keyboard handling and their View menu items. The panel shows the open-items list with its scopes (Needs you, All open), its keys (A, J, K, Delete, Enter) and its cards, unchanged.
- On the phone, the open items still open as a bottom sheet from the strip's count. (The accepted phone idea says "the phone has no right-hand panel"; deciding an item on the phone without that sheet needs inline controls, which is a separate step. Say so in your report; do not build it.)
- Remove the code that only the removed tabs used. Keep any stored data.

### 7. Find

- Edit › Find searches hidden lines too, and going to a match shows its line, as a jump does.

## How to express it

- A new module `src/shared/folded-view.ts` holds `FOLDED_VIEW_POLICY` and the pure functions: the title and top-level sections, the shown set, the hidden runs and their labels, the count line's text. Its header comment cites Mike 2026-09-24, yfbqrau4 point 9, the accepted "Other ideas" line, and Claude's open proposal (P5) for the count line and the visit rule.
- Every choice where this brief is silent is a named constant with a one-line comment. At least: `startsFoldedEachVisit`, `holdsStillWhileReading`, `countLine` (these three follow the open proposal), `shows: 'all-open'`, `openingCollapses: true`, `jumpShowsLineOnly: true`, `refuseEditsTouchingHidden: true`, `loadTimeoutMs: 5000`.
- `src/editor/plugins/fold-view.ts` hides top-level blocks only. Extend it to hide nested nodes (list entries, table rows) by position, keeping ordered-list numbering. Reuse its rule widget (`aov-rule`, `FOLD_RULE_EVENT`); it already keeps a press from moving the caret. On the phone, a rule's tap target is at least 44 px tall.
- Remove `NAVIGATOR_POLICY.tabs` entries `outline` and `since` with a comment citing the accepted idea.

## Tests and checks

- A unit suite `src/tests/folded-view.test.ts`, wired into `npm test`: the title rule (with and without a title; a document with no headings, where every line is in the opening), top-level sections, path headings, nested lists, tables, hidden runs and labels, the count line's text for each case above, and the shown set under position mapping (an edit inside a shown line, an insertion above it, a new line from Enter).
- A browser check `scripts/folded-view-check.mjs`, at 1440 px in both review styles and on the phone (390 × 844), on a local test document with a title, an opening paragraph, a section with an ordered list of six entries where entries 3 and 5 carry pending proposals, a section with a nested `###` subsection holding one proposal, and a section with nothing open. It must check:
  - on load, only the title, the top-level headings, the three open lines and the one path heading show; each rule's label is right; entries 3 and 5 read "3." and "5."; the count line is right; no Outline or Since you tab exists;
  - accepting entry 3 from the right-hand list (A) keeps it shown and moves one count from open to in accord;
  - a second writer adds a proposal inside a hidden run: nothing shown moves, that rule's label says "1 open", the list gains the row, and J to that row shows the line without unfolding its section;
  - a rule click shows exactly its lines; a chip unfolds, then refolds to the heading and its shown lines;
  - "Show the whole Accord" shows every line and becomes "Show only open items", which folds again;
  - a reload starts folded, even after "Show the whole Accord";
  - a click in a shown item places the caret and typing makes a live proposal; Backspace at the start of entry 5 (a rule before it) is refused with the notice and the text is unchanged; ArrowUp from entry 5 does not land in a hidden line;
  - Edit › Find for a word only in a hidden line shows that line;
  - on the phone: the same first view, rule tap targets of at least 44 px, and the open-items sheet still opens from the strip.
  Save screenshots in `.preview/`.
- Update every existing check that uses the Outline tab, the Since you tab, stored folds, "Collapse all sections" or "Expand all sections", or assumes a document opens whole. Find them with `grep -ln "anv-tab\|data-tab=\"outline\"\|data-tab=\"since\"\|pfold-controls\|Collapse all sections\|Expand all sections\|proof:fold:\|setFolded\|__proofOpenView" scripts/*-check.mjs`. At least `folding-check`, `layout-check`, `layout-v2-check`, `open-view-check`, `honest-reading-check`, `reading-walk-check`, `usability-s1-check` and `mobile-check`. A check that must open a document whole calls the whole-Accord control first; say which checks do that.
- Never delete an assertion for behaviour that still exists. Name each assertion you retire and why.
- Your sandbox cannot start Chromium, so the reviewer runs the browser checks: every `scripts/*-check.mjs`, not only the ones named here. Run `npm run build` and `npm test`.

## What must not change

- The server, the API, stored marks, the marks guard, the collab protocol and the client's writes. This step is view-only, so `COLLAB_VERSION_POLICY.minVersion` stays 0.33.0. If you find you must change a client write, stop and say so in your report.
- Step 3's behaviour: click-to-edit, live proposals, withdrawal, deleting a proposal rejects it, the guest notice, the typing path (`commitLiveTextInput`). Every step 3 check stays green.
- Hover changes nothing, and no review pop-ups (rulings 2026-09-19 and 2026-09-23).

## Report

Give your report as your final message. It must name: what changed and in which files; each new or changed policy constant; which suites you ran and their results; which you could not run; each existing check you changed and why; anything you did not verify; and anything in this brief you think is wrong, with the reason. Do not commit. The reviewer commits for you as `Codex <codex@openai.com>` with `Seat: codex-builder` and `Bead: ac-2a8`.
