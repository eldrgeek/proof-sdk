# Brief: one side panel, on the left (2026-09-24)

_Brief by Claude Opus 5.5 (CCc session 1997a29b, the reviewer) for Mike Wolf, 2026-09-24. Builder: Codex (seat `codex-builder`). Bead `ac-2vs`. Branch `codex/accord-left-panel`, cut from `origin/deploy/vps` at 1cfdeb3._

## Why

Mike and Claude reached accord today on "The Accord rules" (https://proof.vpsmikewolf.duckdns.org/d/gfmd0z5p), recorded in `docs/accord/rulings.md` under "The Accord rules (2026-09-24)". Under those rules nobody marks lines: a passage is in accord because one party wrote it and the other accepted it. The editor still asks the reader to mark every line, mostly through the right-hand panel.

Mike, the same day, about the layout, verbatim:

> "The open items currently in the left panel is useful. The right hand panel (agree, suggest change, etc) is not. You might consider moving the right panel to the left and restoring the list of accords to the left with an option for closing the panel and having more space."

The reviewer's reading, which this brief builds:

1. The right-hand panel (the Margin) goes away. Its Line tab (Agree, Suggest change, Discuss, Reject, "Agree with this section", "Marked by N", the ⋯ More menu, the Familiar note) is the line-marking model the rules retire.
2. What the right panel still does that is worth keeping, the Room (the document's chat), moves into the left panel.
3. The list of Accords (the documents list, today only in File › Open) comes back to the left panel.
4. One control closes the left panel so the text gets the whole width, and the same place reopens it.

## What to build

### 1. Desktop: no right panel

- The Margin does not render on desktop. Its Line tab content does not render anywhere on desktop.
- The A and R keys no longer mark lines; they do nothing. J and K still move. S (Suggest change) and T (Discuss) keep working exactly as today.
- Keep every capability the Line tab offered that is not line marking, by the routes in section 3.

### 2. The left panel (the Navigator) is the only side panel

From top to bottom:

a. **Accords.** The documents list, the same data File › Open shows (`ReadingWalk.documentsList()`): one row per Accord with its title, "open now" on the current one, and its count badge; each row links to `/d/<slug>`; an "All Accords" link to `/` at the end. Use the product noun from `src/shared/product-identity.ts`, not a hard-coded word. The heading "Accords" has a disclosure that collapses the list; the reader's choice persists the way the panels' open/closed state persists today (the rail state, `parseRailState`). When the list is not available (signed out, or the library is off), show the same message File › Open shows, in one line.

b. **Tabs: Review · Outline · Since you · Room.** Review, Outline and Since you are unchanged. Room is the chat pane the Margin's Room tab shows today (`chatSlot`), moved, not rebuilt. The Room tab's @mention badge moves with it. An explicit act that opens the chat today (a speech bubble, a chat link, the ⋯ menu's Room item, `MARGIN_POLICY.explicitChatOpensRoom`) now opens the left panel on the Room tab.

c. **Close and reopen.** The « control in the panel's header closes the whole panel, and the text column takes the freed width. The » control at the top left reopens it, as today. The View menu's "Review panel" checkbox becomes "Side panel" and does the same. The panel stays closed by default under 1100 px (`NAVIGATOR_POLICY.closedBelowPx`, unchanged).

d. **Width.** Choose a width that fits Accord titles (the policy says 240 px today). Put the number in `NAVIGATOR_POLICY` with a one-line reason.

### 3. Suggest change and Discuss without the right panel

- When a passage is selected (a click selects it, as today), show a small action strip attached to that passage with two buttons: "Suggest change" (S) and "Discuss" (T). They start exactly the flows the Line tab's buttons start today: Suggest change opens the inline local draft; Discuss opens a thread on the passage.
- The strip must not cover the words being read. Place it in the gutter beside the passage or at the passage's end, and say which you chose and why.
- Hover changes nothing (ruling 2026-09-23). The strip follows the selection only, and it does not move while the reader types in a draft.
- The text-selection bar (Comment, Thread, Flag, Suggest) that appears on a dragged selection is unchanged.

### 4. The gutter

- The mark circles beside each line (empty, Seen, Agreed and the rest) no longer render.
- The amber "needs you" dot on a line with an open item stays, because it is how a reader finds an open issue in the text. Clicking it still opens that line's items in Review.

### 5. Phone (under 700 px)

- The Margin sheet's Line tab goes the same way as on desktop.
- The Navigator sheet gets the Accords list at its top and the Room tab beside Review, Outline and Since you.
- The phone strip keeps the title, the Review count and ⋯.
- The passage action strip works by touch.

### 6. What must not change

- The server, the API, stored marks, the collab protocol and the client's writes. Line marks already stored stay stored; they are only no longer asked for or drawn. If you find you must change a client write, stop and say so in your report, because `COLLAB_VERSION_POLICY.minVersion` would then have to rise (rule in AGENTS.md).
- No review pop-ups, and nothing folds or moves while the reader reads (rulings 2026-09-19 and 2026-09-23).

## How to express it

Every choice is a named constant in `src/shared/layout-panels.ts` (for example a desktop flag on `MARGIN_POLICY`, the Room tab in `NAVIGATOR_POLICY.tabs`, an Accords-list policy, a gutter policy), each with a comment citing Mike 2026-09-24 and the Accord gfmd0z5p. That keeps any later ruling a one-line change, as the rest of the codebase does.

## Tests and checks

- Update the unit suites that assert the Margin or its Line tab. Add unit coverage for each new policy.
- Add a browser check, `scripts/left-panel-check.mjs`, at 1280 and 1440 px and at phone width, in both review styles:
  - no right panel;
  - the Accords list is present, and the current Accord is marked "open now";
  - the four tabs, with Room posting and showing a message on a local test document;
  - closing the panel widens the text column, and reopening restores it;
  - clicking a passage shows the action strip; "Suggest change" opens a draft; "Discuss" opens a thread;
  - A and R do not create a line mark;
  - no mark circles in the gutter, and the amber dot is present on a line with a pending suggestion.
  Save screenshots in `.preview/`.
- These existing checks must stay green or be updated with a stated reason: `layout-check`, `reading-walk-check`, `chat-check`, `mobile-check`, `comment-check`, `edit-gesture-check`, `open-view-check`, `hover-touch-check`, `line-marks-check`, `usability-acceptance-check`, `ux-consistency-check`, `mike-0921-check` and `marks-restart-check`.
- Your sandbox cannot start Chromium, so the reviewer runs the browser checks. Write the new check anyway, and say in your report that you did not run it.

## Report

Write your final report to the `-o` file. It must name: what changed and in which files; each new or changed policy constant; which suites you ran and their results; which you could not run; anything you did not verify; and anything in this brief you think is wrong, with the reason. Do not commit; the reviewer commits for you as `Codex <codex@openai.com>` with `Seat: codex-builder` and `Bead: ac-2vs`.
