# Brief: the Accord layout, step 1 of the build order (2026-09-24)

_Brief by Claude Opus 5.5 (CCc session 1997a29b, the reviewer) for Mike Wolf, 2026-09-24. Builder: Codex (seat `codex-builder`). Bead `ac-2vs`. Branch `codex/accord-layout-v2`, cut from `origin/deploy/vps` at 1cfdeb3._

## Why

Mike and Claude agreed on "The Accord rules" (https://proof.vpsmikewolf.duckdns.org/d/gfmd0z5p; `docs/accord/rulings.md`, "The Accord rules (2026-09-24)"). Under them nobody marks lines. Mike then described how the editor should work. That design is the Accord "The Accord editor" (https://proof.vpsmikewolf.duckdns.org/d/yfbqrau4). Its build order, which Mike accepted, starts with this step:

> "1. The layout: Accords on the left, open items on the right with A, J, K and Delete, the chat at the bottom, and no line marks. Nothing here waits on anything else."

Mike's own points that this step builds, verbatim from that Accord:

> 1. The left panel is the list of Accords, like the list of chats. The panel can be closed.
> 2. The right panel has the list of open items.
> 3. Clicking an item in that list takes you to the open item.
> 4. Typing A accepts the item selected in the right-hand list. J and K move to the next and previous open item, and the document follows. Delete rejects the selected item.
> 10. You can continue the conversation that started the chat by writing a question or a request, like "@claude rewrite section 2", at the bottom of the chat.

A branch from an earlier, wrong reading exists: `codex/accord-left-panel`, commit e6e3ec2 (unreviewed, stopped mid-run). It put an Accords list inside the left Navigator. You may read it with `git show e6e3ec2` for reusable pieces. Do not build on its layout.

## What to build

### 1. Left panel: the list of Accords

- The left panel shows only the list of Accords, like the conversation list in a chat app. Use the data File › Open already shows (`ReadingWalk.documentsList()`): one row per Accord with its title, the current one highlighted, and its count badge; each row links to `/d/<slug>`.
- At the top of the list, a "New" control does what File › New does. At the bottom, "All Accords" links to `/`.
- Use the product noun from `src/shared/product-identity.ts`, never a hard-coded word.
- When the list is not available (signed out, or the library is off), show in one line the message File › Open shows.
- One control closes the panel, and the document takes the freed width. The same place reopens it. The View menu item for this panel says "Accords list". The open or closed state persists the way the panels' state persists today (`parseRailState`). The panel is closed by default under 1100 px.

### 2. Right panel: the open items

- The right panel shows the list of open items: today's Review list (the Navigator's Review tab, `navigator.ts`), moved from the left side to the right. Its rows, its count and the "Changes on this line" cards (Accept, Reject, Reply, Why) stay as they are.
- Outline and Since you stay as tabs in the right panel for now. Step 2 (the folded view) will remove them.
- The Margin's Line tab (Agree, Suggest change, Discuss, Reject, "Agree with this section", "Marked by N", the ⋯ More menu, the Familiar note) no longer renders, on desktop or on the phone.
- The right panel can also be closed and reopened, with its state persisted the same way.

### 3. Keys in the right-hand list

- Clicking a row selects it and takes the document to that item (as clicking a Review row does today). Keyboard focus stays in the list.
- While the list has focus: J and K select the next and previous open item, and the document follows; A accepts the selected item; Delete (and Backspace) rejects it; Enter moves focus into the document at that item.
- A and Delete act only on items that are proposals (suggestions, and bundles as one unit). On any other kind of open item, they do nothing and show a one-line hint saying what the item is and how to answer it. An ask keeps its own Yes, Not yet and No buttons under its question line.
- An accept or reject by key goes through exactly the same client call as the card's button, and it gets the same undo entry.
- These keys do nothing while the caret is in the document or in a text field. A never types into the text, and Delete never rejects anything while someone is typing.
- The old line-mark keys stop marking lines: A no longer marks Agreed, and R no longer marks Rejected, anywhere.

### 4. The chat at the bottom

- The Room chat moves from the Margin's Room tab to the bottom of the centre column. The box you type in is always visible there. Just above it is the latest message, and one control expands the whole conversation upward over the document and collapses it again.
- It is the same chat, not a new one: `chatSlot`, `document_chat_messages`, the same endpoints, the same @mention badge. Any explicit act that opens the chat today (a speech bubble, a chat link, the ⋯ menu's Room item) now expands this conversation.
- Nothing answers a message automatically yet. That is step 5.

### 5. The gutter

- The mark circles beside each line (empty, Seen, Agreed and the rest) no longer render.
- The amber dot on a line with an open item stays. Clicking it selects that item in the right-hand list.

### 6. Phone (under 700 px)

- The Accords list is a drawer that slides in from the left, opened from a control at the top left, as in chat apps.
- The chat box stays at the bottom of the page.
- The open items open as a bottom sheet from the phone strip's count, as the Review sheet does today.
- The Line tab is gone here too.

### 7. What must not change

- The server, the API, stored marks, the collab protocol and the client's writes. Stored line marks stay stored; they are only no longer asked for or drawn. If you find you must change a client write, stop and say so in your report, because `COLLAB_VERSION_POLICY.minVersion` would then have to rise.
- Editing still starts with S, with Suggest on the text-selection bar, or with the status bar's hint. Typing straight into the text stays switched off (`EDIT_SESSION_POLICY.convertDirectEditsToProposals`). That is step 3, and it has its own test gate.
- No review pop-ups. Hover changes nothing. Nothing folds or moves while the reader reads (rulings 2026-09-19 and 2026-09-23).

## How to express it

Every choice is a named constant in `src/shared/layout-panels.ts`, with a comment citing Mike 2026-09-24 and the Accord yfbqrau4. That keeps a later ruling a one-line change, as the rest of the codebase does.

## Tests and checks

- Update the unit suites that assert the Margin, its tabs or the Navigator's side. Add unit coverage for each new policy and for the key handling in the list (A, Delete, J, K, Enter; nothing while typing).
- Add `scripts/layout-v2-check.mjs`, at 1280 and 1440 px and at phone width, in both review styles. It must check:
  - the left panel lists Accords with the current one highlighted, and closing it widens the document;
  - the right panel lists open items, and clicking a row takes the document to it;
  - on a local test document with two pending suggestions: J selects, A accepts the first (the text changes, and undo restores it), Delete rejects the second;
  - typing A and Delete with the caret inside a Suggest change draft changes only the draft;
  - the chat box is at the bottom, and a message posted there shows as the latest message;
  - no Line tab, no mark circles, and an amber dot on a line with a pending suggestion;
  - on the phone: the drawer opens and closes, and the open-items sheet opens from the strip.
  Save screenshots in `.preview/`.
- These existing checks must stay green, or be updated with a stated reason: `layout-check`, `reading-walk-check`, `chat-check`, `mobile-check`, `comment-check`, `open-view-check`, `hover-touch-check`, `line-marks-check`, `usability-acceptance-check`, `ux-consistency-check`, `mike-0921-check`, `asks-check`, `threads-check`, `edit-gesture-check` and `marks-restart-check`.
- Your sandbox cannot start Chromium, so the reviewer runs the browser checks. Write the new check anyway, and say in your report that you did not run it.

## Report

Give your report as your final message. It must name: what changed and in which files; each new or changed policy constant; which suites you ran and their results; which you could not run; anything you did not verify; and anything in this brief you think is wrong, with the reason. Do not commit. The reviewer commits for you as `Codex <codex@openai.com>` with `Seat: codex-builder` and `Bead: ac-2vs`.
