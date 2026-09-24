# Brief: editing by clicking, as live proposals (step 3 of the build order, 2026-09-24)

_Brief by Claude Opus 5.5 (CCc session 1997a29b, the reviewer) for Mike Wolf, 2026-09-24. Builder: Codex (seat `codex-builder`). Bead `ac-8ae`. Branch `codex/accord-click-edit`, starting at b6577db: step 1 (the layout) is merged and live there, so read its commit (`git show --stat b6577db` and its brief `docs/accord/layout-v2-brief-2026-09-24.md`) first._

## Why

"The Accord editor" (https://proof.vpsmikewolf.duckdns.org/d/yfbqrau4) is Mike's design, and its build order (accepted) says:

> "3. Editing by clicking, as proposals (points 5 and 6). This waits on the known bug that can duplicate the whole document when two people edit the same line. Its fix must pass its test five times in a row before this step ships."

Mike, 2026-09-24: "go ahead and build step 3 too."

Mike's points, verbatim from that Accord:

> 5. Clicking in the item lets you edit it, and that is a proposed change that others need to accept.
> 6. You reject an item by deleting the entire thing.

Claude's two proposals on them, still open in the Accord, which this step builds as proposed (Mike can still reject them; keep each behind a named policy constant so a ruling is a one-line change):

> P2. Others see your typing at once, as your proposal, the way Google Docs shows a suggestion; there is no separate Propose step. Editing someone else's open proposal changes that proposal, instead of adding a second one on top of it.
> P3. Deleting someone's proposal rejects it, and the original comes back. Deleting agreed text proposes its deletion, which the other party accepts or not. Undo restores anything deleted.

## What the reviewer found (facts, checked 2026-09-24)

- **The duplication fix is live.** `src/editor/local-write-resync.ts` (ported from b8a7c97 in f41d98e) stops a local write to a line a remote writer is touching from resyncing the whole document. On 2026-09-24 `local-write-resync-check` passed 5 of 5 runs and `caret-stability-check` passed 5 of 5 runs (44 of 44 checks each), with a second writer on the same line.
- **The old conversion path is gone.** `EDIT_SESSION_POLICY.convertDirectEditsToProposals` has no reader: f41d98e removed the code in `src/ui/edit-gesture.ts` that read it (it was at line 198 in 27bd48e). Do not revive that design. It typed into the document in Editing mode and converted on the way out, which writes twice.
- **The engine has an in-place suggesting mode.** `src/editor/plugins/suggestions.ts` turns edits into `proofSuggestion` marks as the person types, when suggestions are enabled (`enableSuggestions`, `isSuggestionsEnabled` in `src/editor/index.ts`). This is the Google Docs behaviour P2 describes. Build step 3 on it.
- **The server guard will fight it unless you change one thing.** `server/collab-marks-guard.ts` restores any pending suggestion a client deletes from the marks map, and after `SUGGESTION_STATUS_POLICY.restoreLimit` (3) restores within `restoreWindowMs` (5 min) it makes the connection read-only and forces a reload. The suggestions plugin deletes the text of a person's own insert when they backspace over it (around lines 212–217 and 373–378), and a suggestion whose text is gone would then be dropped from the marks map. That is a client deletion of a pending suggestion: the guard would put it back, and three corrections in five minutes would lock the page. The rule from ac-lhc stands: absence from a view is never a suggestion decision. Every way a pending suggestion ends must be a recorded decision (`suggestionWithStatus` in `src/shared/suggestion-status.ts`), never a deletion.

## What to build

1. **Clicking in the text places the caret there, and typing is a proposal.** For anyone who may suggest, the Accord page runs the in-place suggesting mode by default. What you type shows at once, to everyone, as your insert; what you delete from agreed text shows struck through, as your deletion proposal; a replacement is one proposal. There is no Propose step and no private draft. This supersedes the 2026-09-23 rulings "a click selects the passage, and editing starts from Suggest change in an inline draft" and "only Propose change or Cmd/Ctrl+Enter publishes".
2. **Retracting your own typing.** Backspacing over all of your own pending insert ends it with a recorded decision (status `rejected`, `resolvedBy` you, and an event that says it was withdrawn by its author), so the guard sees a decision, not a deletion. Partly editing your own pending insert just changes it.
3. **Deleting someone else's proposal rejects it (point 6).** Deleting the whole of another person's pending insert, or the whole of a replacement's new words, rejects that proposal through exactly the path the Reject button uses (status, event, undo entry). For a replacement, the original words come back.
4. **Editing inside someone else's open proposal changes that proposal (P2, second sentence).** The proposal's new words become the editor's version, and the original author is recorded; the original author (or anyone but the editor) accepts it. If this cannot be done safely in this step, keep the engine's current behaviour, say exactly what it does in your report, and leave a named policy constant for it.
5. **Undo** restores anything typed or deleted, and a reject by deletion, with the same undo stack the rest of the page uses.
6. **Letter keys type.** While the caret is in the text, every key types or edits: A types A, Delete deletes. The list keys from step 1 (A, J, K, Delete) act only when the right-hand list has focus. Escape leaves the text and returns focus to the list, or to the page.
7. **Asks, comments, threads and AI suggestions are unchanged.** An ask keeps its Yes, Not yet and No buttons. An AI's suggestions still arrive through the API with their reason. The drafts code stays in the tree behind a policy constant that is off, for a quick rollback, and nothing else may call it.
8. **The status bar stops speaking the retired model.** "No marks from you yet" and "You marked up to line K" come from line marks, which the Accord rules retire. Remove them. The bar keeps the line position and the count of open items, and its Reading and Writing word follows the caret: Writing while the caret is in the text, Reading otherwise. (Bead ac-197 holds this item.)
9. **Raise `COLLAB_VERSION_POLICY.minVersion`** (`src/shared/collab-version.ts`), because the client's writes change: an older page must reload before it can edit, exactly as the ac-lhc fix did (the rule is in AGENTS.md).

Express every choice as a named constant (for example in `src/shared/edit-session.ts`), with a comment citing Mike 2026-09-24 and the Accord yfbqrau4. Replace the dead `convertDirectEditsToProposals` constant with the constants this step actually reads, and update `src/tests/edit-session.test.ts` to match.

## What must not change

- The server, the API, the stored mark format (statuses stay `pending`, `accepted` and `rejected`), the marks guard, and the collab protocol. The guard stays exactly as it is: the client is what changes, so that it never deletes a pending suggestion without a decision.
- The layout from step 1, except where click and key handling must change.
- No review pop-ups. Hover changes nothing. Nothing folds or moves while the reader reads.

## Tests and checks

- Unit coverage for every new constant, for "a suggestion's end is always a status, never a deletion" (for the author's retraction and for delete-to-reject), and for the key rules in point 6.
- A new browser check, `scripts/click-edit-check.mjs`, in both review styles, at 1440 px and at phone width, with two browser contexts (two people) on one local document:
  - a click places the caret, and typed words appear to the second person as the first person's pending insert within two seconds;
  - deleting agreed words shows them struck through as a pending deletion; a replacement is one proposal;
  - the author backspaces over all of their own insert, five times within five minutes: the proposals end as withdrawn, no server restore happens, no `collab.reload_required` event is recorded, and the page stays editable;
  - the second person deletes the whole of the first person's insert: it is rejected (status and event), and for a replacement the original returns; Undo brings it back;
  - both people type on the same line at the same time for ten seconds: no text is written twice, the Yjs fragment and the document agree, and every character each typed is present exactly once;
  - A types the letter A in the text, and Delete deletes a character; neither accepts nor rejects anything.
- The gate, run by the reviewer: `click-edit-check`, `local-write-resync-check` and `caret-stability-check` must each pass five runs in a row with this step switched on. `marks-restart-check` must pass. Also keep green, or update with a stated reason: `edit-gesture-check`, `insert-suggestion-check`, `suggestion-positions-check`, `comment-check`, `mobile-check`, `threads-check`, `asks-check`, `usability-acceptance-check`, `layout-v2-check`.
- Your sandbox cannot start Chromium, so write the checks and let the reviewer run them. Say so in your report.

## Report

Give your report as your final message: what changed and in which files; each new or changed policy constant; what the suggestions plugin does in each case in "What to build" after your change; which suites you ran and their results; which you could not run; anything you did not verify; and anything in this brief you think is wrong, with the reason. Do not commit. The reviewer commits for you as `Codex <codex@openai.com>` with `Seat: codex-builder` and `Bead: ac-8ae`.
