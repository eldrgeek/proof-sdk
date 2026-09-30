# Brief: a question typed into an item becomes a discussion, step 4 of the build order (2026-09-25)

_Brief by Claude Opus 5.5 (CCc session 1997a29b, the reviewer) for Mike Wolf, 2026-09-25. Builder: Codex (seat `codex-builder`). Beads `ac-yoc` (Part A) and `ac-t17` (Part B). Branch `codex/accord-discussions`, cut at b9249be: steps 1, 3 and 2 are live (b6577db, efc176f, a59f5c0); b9249be adds only docs/accord/rulings.md._

## Why

Mike and Claude agreed on the Accord "The Accord editor" (https://proof.vpsmikewolf.duckdns.org/d/yfbqrau4) on 2026-09-25; `docs/accord/rulings.md`, "The Accord editor (2026-09-25)". It is the design the editor is built to. Its build order says:

> "4. Questions typed into an item become discussions (point 11)."

Mike's point 11, verbatim, as agreed:

> "You can start a discussion on an item by typing something, like "What is your reasoning?", that is interpreted as a request for discussion. Text typed at the end of an item becomes a discussion, not an edit, when it ends with a question mark or starts with @ and a name. It shows as a thread beside the item, with one click to turn it back into text."

The Accord's definition, verbatim:

> **Item** — one unit of an Accord's text: a paragraph, a list entry, a heading or a table row.

Mike, 2026-09-25: "Let's make it work on desktop before going to mobile." Build and verify desktop first; the phone must not get worse than it is.

Mike on Part B's subject: the page and the server must not disagree about whether an Accord is in accord. After he accepted every proposal in yfbqrau4, the page said "In accord: all 58 items" and the server's `/state` said `aligned: false` with 58 issues.

## What the reviewer found (facts, checked 2026-09-25 on b9249be)

- **Typing is a live proposal (step 3).** `src/editor/plugins/suggestions.ts` turns typing into `proofSuggestion` marks as the person types. Consecutive typing by one person coalesces into ONE `insert` mark (`getCoalescableInsertCandidate`, `lastInsertByActor`), so a typed sentence is one insert id. `src/editor/live-suggestion-input.ts` publishes ordinary input during `beforeinput` (`EDIT_SESSION_POLICY.synchronousTextInput`).
- **Ending your own pending insert is a recorded decision.** Deleting the whole of your own insert calls `rejectOne(id)` in suggestions.ts (around line 207): status `rejected`, `resolvedBy` you, which reads as a withdrawal (`EDIT_SESSION_POLICY.withdrawOwnInsert`). `server/collab-marks-guard.ts` restores any pending suggestion a client deletes from the marks map, and after 3 restores in 5 minutes it makes the connection read-only and forces a reload. **The rule from ac-lhc stands: every way a pending suggestion ends must be a recorded decision (`suggestionWithStatus`, `src/shared/suggestion-status.ts`), never a deletion.**
- **Threads exist and are one object** (`src/shared/threads.ts`, read its header). A thread with no diff is a discussion; its default closing condition is `asks: 'answer'` (`THREAD_POLICY.defaultForDiscussion`); `threadOpenFor` makes it open for everyone but its author until someone answers (`answer-this`), then open for the author to close (`close-yours`). `waitingOn` names who it waits on (empty means everyone but the author).
- **Starting a thread**: `LineMarksUI.startThread({ lines, text, asks, selection, waitingOn })` (`src/ui/line-marks.ts`, around line 3114). It places the thread's words as a comment on the first line (`host.commentOnLine`), stores the thread row (`POST /documents/:slug/threads`, `server/routes.ts` around line 2394), toasts, and pushes an Undo entry that calls `POST /documents/:slug/threads/:id/undo` (only the person who started it) and resolves the comment.
- **Showing a thread**: `src/ui/threads.ts` `ThreadsPanel` renders the threads on the focus line (`card()`, around line 232). Threads are passed to `reviewSurface` (`src/shared/review-list.ts`; called in `src/ui/line-marks.ts` around line 732), which feeds the amber dots, the Review pill and the Review list, and the folded view shows the lines that are open. So an open discussion already shows in the other person's Review list and keeps its item shown in the folded view. The gutter count ("1 comment") is `.plm-review-marker` (`src/ui/line-marks.ts` around line 1514).
- **Mentions**: `mentionNamesFor(actor, label)` in `src/shared/chat.ts`; the chat composer builds the document's candidates in `src/ui/chat.ts` (`mentionNames()`, around line 512); the server has `mentionCandidates(slug)`.
- **Escape while writing** is handled in `src/editor/editing-guard.ts` (around line 85, `EDIT_SESSION_POLICY.escapeReturnsToReview`). "Writing" means the caret is in the text (`isWriting()`, `EDIT_SESSION_POLICY.caretDefinesWriting`).
- **The folded view** (`src/editor/plugins/fold-view.ts`, `src/shared/folded-view.ts`) refuses typing that would change hidden text. A line the person is typing in is shown.
- **The view never jumps**: `src/editor/caret-anchor.ts` holds the reader's line on screen across foreign transactions. The conversion below must not move the page.

## What to build

### Part A — step 4 (bead ac-yoc)

1. **The rule, in a new policy module `src/shared/typed-discussion.ts`** with `TYPED_DISCUSSION_POLICY` (every decision below that Mike's words do not fix is a named constant) and pure functions the editor and tests call:
   - A **typing run** is one pending `insert` proposal by the person typing, lying at the END of an item: nothing but whitespace follows it inside that item. An item is a paragraph, a list entry, a heading or a table row (the Accord's definition).
   - The run **is a discussion** when its text, trimmed, ends with `?` (allow closing quotes or brackets after it), or starts with `@` followed by a name that matches one of the document's mention candidates (a person or an AI on the document; the same names the chat accepts). An `@` that matches no candidate, or an e-mail address, is text.
   - Everything else stays an edit, exactly as in step 3. A `?` in the middle of the run ("Is it? Yes.") does not make it a discussion. A run in the middle of an item is an edit even when it ends with `?`.
   - Suggested shape: `classifyTypedRun(text, candidates) → { discussion: false } | { discussion: true, reason: 'question' | 'mention', waitingOn: string[] }` and `isRunAtItemEnd(...)`.
2. **When the run is judged**: when it ends, not on each keystroke and not on a pause. It ends when the person presses Enter at the end of the run, presses Escape, moves the caret out of the item (click, arrow keys, J/K, Tab), the editor loses focus, or the page is hidden. While a run qualifies, a one-line hint shows beside it (a policy string; suggested: "Enter sends this as a discussion"), so the change never surprises. Enter at the end of a qualifying run sends it and does not split the item; Shift+Enter keeps the normal behaviour.
3. **The conversion is one action with one Undo entry**:
   - withdraw the run's insert proposal with a recorded decision (the `rejectOne` / withdrawal path), so its words leave the item and the guard sees a decision;
   - start a thread on that item with `startThread`: the run's text trimmed, `asks: 'answer'`, `waitingOn` the mentioned actor for a mention and `[]` for a question;
   - say so in one line (suggested: "Asked as a discussion on line N. Undo turns it back into text.");
   - Cmd/Ctrl+Z (and Edit › Undo) right after reverses it: the thread is taken back through `/threads/:id/undo` and the words return at the end of the item as the person's live proposal. The step 3 undo grouping (`keepUndoGroupOpen` in `src/editor/review-decision-history.ts`) and the one Undo UI must keep working.
4. **"With one click to turn it back into text"**: on the thread's card, for its author and while it has no reply, one control, "Turn back into text", does exactly what that Undo does. After anyone replies, the control is gone, because it is a discussion now.
5. **Guests**: a guest who may not edit cannot type in the text, so the rule never reaches them. Change nothing about guests.
6. **Phone**: the rule applies wherever typing does. Verify desktop fully first; the new check also runs one phone configuration.
7. **minVersion**: the client writes nothing new (a withdrawal decision, a comment and a thread row are all existing writes), so leave `COLLAB_VERSION_POLICY.minVersion` at 0.33.0. If you add a new kind of write, raise it and say why.

### Part B — ac-t17: the server reports alignment by the Accord rules

- `GET /api/agent/:slug/state` returns `alignment` built in `server/agent-routes.ts` (its `teamRule` string says "owner + everyone who has line-marked, commented, replied or suggested + active agent keys") from the retired line-marks issue report: a line is an issue until every team member has marked it.
- Under the Accord rules (`docs/accord/rulings.md`, "The Accord rules (2026-09-24)") an open issue is a change one party made that the other has not yet accepted, and it is the only kind of open item. Make `alignment.aligned` and `alignment.counts` come from the open items the page counts: pending proposals, open asks and open threads, the same answer `reviewSurface` / the folded view's count line give (compute it server-side from the same shared code; do not duplicate the rules). Count the people who accepted or rejected a change as team members. Keep the record's shape and field names so callers do not break; replace the `teamRule` text with one that says what the new rule is.
- Do not change when an aligned snapshot is frozen (`freezeIfAligned`, `server/alignment.ts`): that writes rows and events, and when an Accord counts as confirmed is Mike's call (rule 13, "We're aligned."). Say in the report exactly what still reads the old model.

## What must not change

- Typing that is not a qualifying run at the end of an item stays a live proposal, exactly as in step 3.
- No client deletes a pending suggestion; the conversion withdraws with a recorded decision.
- Asks (Yes, Not yet, No), comments, threads started with T or the Thread button, the `?` clarify gesture, AI suggestions through the API, the Review list keys (A, J, K, Delete when the list has focus): unchanged.
- The folded view: nothing folds, opens or moves while the person reads; typing into hidden text stays refused.
- The page never scrolls because of the conversion.
- Step 3's caret behaviour (`src/editor/pointer-selection.ts`) and one Undo per typing run.

## Tests and checks

- Unit: `src/tests/typed-discussion.test.ts`: the classifier (a question; a question inside closing quotes; `?` mid-run; trailing spaces; a known `@name`; an unknown `@name`; an e-mail address; empty) and the end-of-item test. Wire it into `npm test` in `package.json`. Part B: a unit test for the new alignment on a document with no open items (aligned) and one with a pending proposal (not aligned, 1).
- Browser check: `scripts/discussions-check.mjs`, both review styles, at 1440 and 390, local server as the other checks do. At the end of an item, type " What is your reasoning?" and press Enter: the item's text is as before, a thread with those words is on the item, and a second reader's Review shows it as needing them. Escape and a click elsewhere also convert. A run that is not a question stays a proposal. "@<a candidate's name> please look" waits on that person. Undo brings the words back as a proposal and takes the thread back; "Turn back into text" does the same; after a reply the control is gone. The page does not scroll during a conversion. The second reader sees the proposal while it is typed and no leftover proposal after it (the withdrawal is recorded). Screenshots in `.preview/`.
- Run `npm run build` and `npm test`. The reviewer runs every `scripts/*-check.mjs`, the five-in-a-row gates and all unit suites against live.

## Report

Your final message is the report: what you built, file by file; each decision the brief left open, with its policy constant; what you did not do and why; exactly what you ran and its result. Codex cannot run Chromium or commit here (AGENTS.md, "Codex specifically"), so say which checks you could not run.
