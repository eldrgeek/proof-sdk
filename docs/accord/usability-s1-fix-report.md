# S1 fix report (bead ac-zhv)

Grok, seat grok-builder, on branch `grok/accord-usability-s1-fix`. The base is commit 47397ad. Node 24.14.0. The browser checks use Playwright Chromium against a local server.

## 1. What changed

The margin mark box attaches its controls again. In `src/ui/line-marks.ts` the S1 diff had deleted both `root.append` calls. The margin box now appends Agree, Reject, More, the reason row and the thread at line 2003. The phone sheet appends Agree and the reason row at line 2005. The old section-reject hint stays gone.

Selecting a passage tells the listeners. `selectPassage` in `src/ui/reading-walk.ts` calls `this.host.focusChanged` at line 968 when the line index or the text identity changes. The chat uses that call. A render is not required.

A foreign position no longer moves the selection to the last line. The mapped callback at `src/ui/reading-walk.ts` lines 294–299 follows the position only when it still falls inside the selected passage. `lineAtPos` otherwise treats a stale list as the last line.

Section agreement is offered only when every line is visible. `sectionAgreementOffer` in `src/shared/folding.ts` starts at line 259. The button in `src/ui/line-marks.ts` lines 1803–1826 reads "Agree with this section (N lines)" when every line is visible. Otherwise it reads "Show all N lines to agree with this section". The click expands the collapsed sections inside that heading (`showSectionLines` in `src/ui/folding.ts`, from line 310). The phone sheet then turns the same button into Agree, because the sheet is not rebuilt. The captured scope is still taken at render time, so a later insertion is not included.

A renamed heading keeps its fold. `remapFoldedKeys` in `src/shared/folding.ts` starts at line 107. It matches the same key, then the mapped position, then the same block and level, then the same heading ordinal when the heading count did not change. A key whose heading is not in the transaction's before-document is kept, so a document load does not wipe stored folds. `mapTransaction` in `src/ui/folding.ts` line 130 uses the transaction's before-document and after-document.

A settled review row keeps the passage it settled on. `resolveSettledIndex` in `src/shared/layout-panels.ts` line 248 resolves hash and occurrence. `renderIssues` in `src/ui/navigator.ts` stores that identity when the row leaves the open list, and it looks the row up by that identity.

A Reject opens "Marked by N" unless the reader has already clicked that row. `src/ui/line-marks.ts` lines 1380–1382 no longer store the first default as a choice. The reason stays visible.

The mark glyph is `aria-hidden` at `src/ui/line-marks.ts` line 1949. The accessible name of Agree is Agree. The phone check looks for that name.

A section collapse names the heading in Undo. `src/ui/folding.ts` lines 331–334 record `collapsed “Quiet”` or `expanded “Quiet”`.

No stored document format, API path, field name, event, or CSS class changed.

## 2. Tests

`src/tests/folding.test.ts` now expects the visibility gate, and it expects a renamed heading to keep its fold when the position map does not land on the heading. `src/tests/layout-panels.test.ts` expects a settled row to follow hash and occurrence after an insert above it.

`npm test` exited 0. The script runs 34 groups. The log contains 495 pass marks. That run was before the last two edits (the Reject fold, and the Undo heading name). Those two edits have no new unit assertion. `npx tsc --noEmit -p tsconfig.json` reports 490 errors. That is the allowed ceiling. `src/editor/index.ts` still has 56 of them. I added two host callbacks there. I did not add an error on a line I wrote. The other files I edited do not appear in the error list.

The check scripts changed as follows.

- `scripts/usability-s1-check.mjs` sends agent edits with `baseToken` or `baseRevision`, the same way `scripts/open-view-check.mjs` does. A folded heading now expects "Show all N lines…". A new case folds only the Alpha detail subsection, shows the lines, and then expects Agree. Showing the lines does not agree a hidden line.
- `scripts/folding-check.mjs` shows the hidden lines before it agrees a folded section, on desktop and on the phone sheet. The resolved-section case does the same.
- `scripts/honest-reading-check.mjs` looks for a button named Seen. The glyph is no longer part of the name. The case still fails. See part 4.
- `scripts/layout-check.mjs` expects "Collapse all sections" and "Expand all sections". Those are the names on the View menu and on the Outline. The old names were "Fold all sections" and "Fold every section".
- `scripts/ux-consistency-check.mjs` expects `collapsed “Quiet”`.

## 3. Browser checks

The reviewer's run of `usability-s1` failed 12 of 29. After these fixes my run is 31 of 31. One case is new. `folding` is 28 of 28. Both were run after the last product build that those two checks depend on. The later Reject-fold and Undo-wording edits do not change those two checks.

The other checks, one at a time. A failing check was run again alone. The second number is that solo run.

| Check | Result | Note |
|---|---|---|
| asks | 26/26 | pass |
| bundles-alts | 30/32, solo 30/32 | stale bundle card never becomes visible |
| caret-stability | 45/48, solo 46/48 | solo failures are the phone Suggesting case the job named |
| chat | 34/34 | the job said three desktop cases failed on the base |
| comment | all passed | |
| cross-invite | 22/22 | |
| dialect | 18/18 | |
| do | 24/24 | |
| edit-gesture | 22/22 | |
| editing-first | 24/24 | the job said this failed on the base |
| folding | 28/28 | assertion updated, then the check passed |
| honest-reading | 16/18, solo 16/18 | Seen button is found; "Seen (marked)" does not appear |
| hover-touch | 18/18 | the job said the phone sheet failed on the base |
| identity | 16/16 | |
| insert-suggestion | all passed | |
| invite | 24/24 | |
| layout | 86/104, then 94/104 after the rename assertions | 10 cases still fail, including the ⋯ More menu |
| line-marks | 16/17, solo 17/17 | the Reject fold now opens, so the reason is in the margin |
| line-tiers | 16/18, solo 16/18 | confirming a proposed tier times out |
| mike-0921 | 46/48, solo 46/48 | opening Room scrolls the chat to the newest message |
| mobile | all passed | |
| open-view | 13/13 | |
| product-name | 28/28 | |
| proxy-marks | 24/24 | |
| reading-walk | 66/70, solo 66/70 | the rail-collapse click times out |
| remote-decorations | 12/12 | |
| review-aids | 16/22, solo 16/22 | Reject range, repair, and flag clicks time out |
| scroll-camera | 25/25 | |
| suggestion-positions | all passed | |
| threads | 10/12, solo 10/12 | proof style only: a yes-no thread and a clarify thread stay hidden |
| usability-s1 | 31/31 | |
| ux-consistency | 24/26, solo 26/26 | assertion updated to `collapsed “Quiet”` |

`line-marks-check.mjs` runs one review style. The 17/17 is playmaker, which is its default.

## 4. What I did not do, and the risk

Round 3, below, finished the checks this section left open. The list here is the state before that round.

I did not push, deploy, or write `.preview/` into the commit. The checks wrote screenshots there. I restored the tracked ones.

I did not re-run the untouched base, so I cannot show a before-count for every check. The five the job named as base failures are caret-stability, chat, editing-first, hover-touch, and layout. On this tree chat, editing-first, and hover-touch passed. caret-stability still fails the phone Suggesting case, and the first run also failed a phone Editing case. layout still fails, including the ⋯ More menu.

I did not finish these failures. Each was run twice.

- The stale bundle card in `bundles-alts`.
- The tier confirm in `line-tiers`.
- The rail-collapse click in `reading-walk`.
- The Reject range, the repair card, and the flag click in `review-aids`.
- The proof-style thread cards in `threads`. Playmaker's thread cases passed.
- "Seen (marked)" in `honest-reading`, after the button name was corrected.
- Ten layout cases. Four are the same five failures in each review style: the Editing label in the bar, the phone "marked up to" strip, an Issue click that does not land on the expected line, the ⋯ More contents, and an Outline chip whose folded state does not match the assertion.
- `mike-0921` expects the Room not to sit at the newest message after the reader opens it. `roomShown` in `src/ui/chat.ts` line 249 scrolls to the end when the Room is shown. I did not change that function. The failure is stable.

The main risk is those unfinished checks. The S1 acceptance check and the folding check pass. Text integrity, permissions, attribution, Undo, and the concurrent-edit gate were not weakened. `convertDirectEditsToProposals` is still false.

## 5. What I think is wrong

The type-check rule says no error may name a file I touched. `src/editor/index.ts` already has 56 errors, and the host object for line marks lives there. I added `sectionAgreement` and `showSectionLines` on that object. The error count stayed 490. I did not clear the old errors.

`captureSectionScope` still returns every line of the section, including lines inside a collapsed subsection. The gate is the offer, not the capture. The Agree button is not shown until those lines are visible, and the scope is captured at that render. A capture that omitted hidden lines would disagree with "Show all N lines", because N counts the hidden lines too.

The job said one remote edit was sent without `baseRevision` or `baseToken`. The check did send `baseRevision: snap.revision`. When the snapshot's revision is null, that value is null, and the server answers `INVALID_REQUEST`. The fix uses `mutationBase.token` when the snapshot has one, and `baseRevision` otherwise.

## Round 3

The reviewer compared this tree with a run of commit 7b5c574 plus the docs, on this machine, before any S1 change. The checks below passed on that run. They failed on this tree. Each failure was an S1 regression, except one layout click that never reached the line. The before number is this tree at the start of the round. The after number is the run after the fix.

### The freeze

S1 skipped a redraw while any element inside the panel was focused. The base skipped the redraw only while an input or a textarea was focused, so a reason field is not wiped. A click leaves its button focused. The box, the changes list, the Issues list, the Outline, and the thread list therefore stayed on the previous paint.

Commit 9bb12b1 restored the narrower guard. A focused button no longer freezes those panels. An input or a textarea still does.

| Check | Before | After | Cause |
|---|---|---|---|
| bundles-alts | 30/32 | 32/32 | The changes list stayed on the previous paint, so the stale bundle card never appeared. |
| honest-reading | 16/18 | 18/18 | The box stayed on the previous paint, so "Seen (marked)" never appeared. |
| line-tiers | 16/18 | 18/18 | Confirm left the row saying "AI proposed context". The row was in the page. The text did not update. |
| review-aids | 16/22 | 22/22 | Reject range, repair, and flag sit in More or beside it. The box did not redraw after the click. |
| threads | 10/12 | 12/12 | Proof only. The resolve button stayed focused, so the list stayed on the previous line. The yes/no card and the clarify card stayed hidden. |

The same freeze was part of layout. After 9bb12b1 the Issue click, the ⋯ More contents, and the Outline chip passed. Two layout cases remained. They are below.

### Room

mike-0921 was 46/48. It is 48/48.

The base `roomShown` called `scrollToEnd`. The base check expected the chat at its newest message. The S1 check expects the opposite. Opening Room keeps the reader's scroll, and the reader clicks "New below ↓" to jump. The base did scroll. The check changed. The rule is that nothing moves unless the reader does it. `roomShown` now calls `follow`, which shows the pill and does not scroll. Sending a message still scrolls.

### The collapse click

reading-walk was 66/70. It is 70/70.

The « button was on screen, and its box did not move. After Undo, the notice "Undid: accepted a change" hangs out of the toolbar. The rails now sit flush under that bar, so the notice covers the Navigator's «. The notice is a message. It took the click. It now has `pointer-events: none` (`src/ui/chrome.css`).

### Editing line N, and the phone strip

layout was 100/104 after the freeze fix. Both review styles failed the same two cases.

The desktop case clicks line 2 and expects "Editing line N". The case before it scrolls 250px. That scroll carries line 2 above the window. The click landed at y = -11, on nothing, and the bar stayed "Reading". Scrolling that line into view and clicking it shows "Editing line 3". The assertion is unchanged. The click now lands on the line (`scripts/layout-check.mjs`). The baseline script did not scroll before this click, which is why the baseline passed. The product still enters Editing when the click reaches the text.

The phone strip showed "Seen" after Agree. The rule in the page already said "You marked up to here", so the mark was written. S1 had added a second skip: if anything in the strip is focused, do not redraw. Agree stays focused, so "Marked up to line 1 ↑" never replaced "Seen". That skip is gone (`src/ui/reading-walk.ts`). The strip redraws when the mark changes.

The full layout run after these two fixes was 103/104. The one miss was proof at 1440: the ⋯ More click timed out at 6000ms. The same proof stage 3, run alone immediately after, was 23/23. I did not change the product for that one miss.

### The remote comment

The narrower guard made usability-s1 fail 29/31. A remote comment redraws the margin box. The focused Agree button was replaced, and focus left it. The check expects that control's HTML to stay the same. After a redraw, focus goes back to the same control, the same status in the same row (`marginControlKey` in `src/ui/reading-walk.ts`). usability-s1 is 31/31 again.

### folding

folding was 28/28 before these last edits. It is 28/28 after them.

`npx tsc --noEmit -p tsconfig.json` still reports 490 errors. None of them name `src/ui/reading-walk.ts`.
