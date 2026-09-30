# S3 fix report (bead ac-nkn)

Grok, seat grok-builder, on branch `grok/accord-usability-s3-fix`. The base is Codex's S3 commit f41d98e. Node for the runs below is 24.14.0. Node 22.22.3 does not start the local server, because the installed SQLite binary does not match that ABI.

## 1. What changed

A draft now follows its passage the way a lapsed mark does.

`resolveDraft` in `src/shared/edit-session.ts:42` matches exact text first. The match is the line hash, and the occurrence breaks a tie between two copies of the same text (`exactDraftLine` at `src/shared/edit-session.ts:49`). If the text has been edited, the draft uses `findLapseTarget` from `src/shared/line-marks.ts`. It does not use `resolveLineAnchor`. That function's fallback is the line that now sits at the old position, and that line can be unrelated. A draft that matches nothing returns null.

`lineFor` in `src/ui/edit-gesture.ts:171` uses that result. A cached position is not identity. A remote edit that replaces the paragraph used to leave the position deleted, and the warning then said the passage was gone.

A draft that cannot re-attach is not drawn in the document. `paintLost` in `src/ui/edit-gesture.ts` puts a button labelled "Drafts that lost their passage" on the status bar when that bar is on screen (`src/ui/edit-gesture.ts:457`). On a phone the status bar is folded into the strip, so the same button is placed on the strip. The panel lists each draft's text, with Copy and Discard (`src/ui/edit-gesture.ts:522`).

While a draft field is focused, a remote edit must not rewrite the field or move it on screen. `beginDocSync` at `src/ui/edit-gesture.ts:238` keeps the draft text and caret. `anchorDraftView` at `src/ui/edit-gesture.ts:282` scrolls the page so the field stays where it was. A wheel, a touch move, or Page Up / Page Down is the reader's own scroll, and that scroll is left alone.

Direct Editing is unchanged as a mode. `EDIT_SESSION_POLICY.convertDirectEditsToProposals` stays false. New class names are `accord-lost-drafts`, `accord-lost-drafts-open`, `accord-lost-draft`, and `accord-lost-draft-text`. No stored field, API path, event, or existing CSS class was renamed.

## 2. Tests

`src/tests/edit-session.test.ts` now asserts three resolutions. Exact text returns the line with `changed` false. An edited sentence returns that sentence with `changed` true, including when an unrelated paragraph now sits at the old ordinal. An unrelated replacement returns null. A live editor case checks the same two outcomes through `lostDrafts()`.

The suite is 10 passed.

`npm test` was run with `NO_COLOR` and `FORCE_COLOR` unset. An earlier run failed in `library-cli` because a Node warning about those two variables was mixed into the command's stdout. The clean run exited 0. All 34 wired commands completed. The edit-session total is 10 passed. The log of that run contains 505 lines that start with a check mark. Several suites print a total instead of one mark per case.

`npx tsc --noEmit -p tsconfig.json` reports 490 `error TS` lines. None of those lines names a file this work edited.

`src/tests/review-decision-collab-browser.test.ts` passed all five cases in one run: 2, 4, 5, 6, and history-order. The cause of the 30 second timeouts was a checkbox the page does not render, `Go to the next mark after I decide`. That control exists only when the review dialog opens from a list row, and that switch is off. The walk preference is now set to false before the page loads. Accept is the margin Accept button, which calls the same decision the dialog used. A refused redo is read from the visible notice, which includes `.pundo-notice`.

## 3. Browser checks the reviewer should run

Run them with Node 24. Each check serves `dist/`, so `npm run build` first. The results below are from this worktree after that build.

| Check | Before this fix | After | Kind of change |
|---|---|---|---|
| `edit-gesture-check.mjs` | 12 failures: the "changed" warning, the Editing equality, and phone clicks on a hidden mode chip | 14/14 proof and 14/14 playmaker | Product fix for the warning (the draft re-attaches and says the passage changed). Check fix for the phone: a click outside the draft uses another passage, because `.pst-mode` is not on screen. Mode text is read with `textContent`. |
| `caret-stability-check.mjs` | Suggesting configs clicked the document and typed there | Suggesting phone 10/10 after the pencil waits for the target line. Suggesting desktop and every Editing config passed in the full configurations | Suggesting configs were rewritten. Typing is in the draft. A second participant edits the same passage. One submission follows. Editing configs still type in the document. |
| `layout-check.mjs` | Phone tap waited for `.pst-bar` to become visible | Passed, both styles, desktop and phone | Assertion updated. A tap selects the passage, Reading stays Reading, and the strip stays on screen. |
| `hover-touch-check.mjs` | Phone tap expected a caret, and the strip to step aside. Desktop hover expected editing from a click | 32/32 on the solo re-run | Assertion updated. Editing is entered with the labelled control. A tap selects, and the strip stays. The phone ⋯ sheet case passed. |
| `reading-walk-check.mjs` | "the keys did not type" on four desktop widths | 74/74 | Assertion setup updated. The check enters Editing before it types `a`, `j`, and `r`. The claims that those keys type, that the focus does not move, and that R does not open the reason field are unchanged. |
| `remote-decorations-check.mjs` | Timed out waiting for typed words | 12/12 | Setup updated. Page A enters Editing before it types. The claims that page B keeps its asks, tags, alternatives, and fold are unchanged. |
| `ux-consistency-check.mjs` | The lone "?" and "Is this right?" did not land in the text | 36/36 | Setup updated. Those sentences are typed in Editing. The clarify rule and the "a real question is not eaten" rule are unchanged. |
| `bundles-alts-check.mjs` | 31/32 in the sweep. One playmaker case timed out at 10 seconds | 32/32 on a solo re-run | No product change. The timeout did not repeat. |
| `chat-check.mjs` | Reported as 3 desktop failures on the untouched base | Passed in the sweep | No change in this bead. |
| `editing-first-check.mjs` | Reported as the view moving while typing, on the base | Passed in the sweep | No separate edit. The draft's screen anchor does not run unless a draft field is the subject. |
| `edit-gesture`, and the checks not named above | Not in the reviewer's failure list | Passed in the sweep: asks, comment, cross-invite, dialect, do, folding, honest-reading, identity, insert-suggestion, invite, line-marks, line-tiers, local-write-resync, mike-0921, mobile, open-view, product-name, proxy-marks, review-aids, scroll-camera, suggestion-positions, threads | No assertion was weakened. |

The layout ⋯ More case is inside `layout-check.mjs`, and that check passed.

## 4. What was not verified

`review-history-authors-browser.test.ts` and `review-history-routes-browser.test.ts` got the same ready-wait, the same walk preference, and, for routes, the same margin Accept. They were not run to a green result.

`review-style-browser.test.ts` and `review-unified-history-browser.test.ts` only changed the ready wait. They no longer wait for `contenteditable="true"`. They were not run. `review-style-browser.test.ts` still drives the old review dialog, including "Start review" and "Accept (A)". That dialog does not open from a row click while `REVIEW_CLICK_POLICY.listRowOpensDialog` is false. A run of that file is likely to fail on those controls.

`.preview/` was restored after the checks. The checks write screenshots there. The reviewer regenerates them.

The lost-draft panel was covered by the unit test `lostDrafts()`. No browser check opens that panel.

`findLapseTarget` returns null when `LINE_MARK_POLICY.lapseSubstantiveEdits` is false. That switch is on. If someone turns it off, an edited passage's draft becomes a lost draft instead of following the text. The brief says to use that search. The switch is inside the search.

A focused draft fights programmatic scrolls that are not a wheel, a touch, or a page key. The reader's own wheel and Page Down are left alone. A script that calls `window.scrollBy` while a draft is focused will be pulled back.

## 5. What looks wrong in the bead or the brief

The sentence "no error may name a file you touched" does not match this base. `src/editor/index.ts` already had type errors before this work. This run still has 490, and none is in a file this work edited. Codex reported the same conflict.

The review-style browser suite still describes the dialog walk. The brief says there are no review pop-ups, and the row click does not open that dialog. Updating that suite was not finished here, because the suite is a long script of dialog steps rather than one ready-wait.

`findLapseTarget` is gated by the mark policy. A draft and a mark then share one switch. The brief names the function. It does not say the draft should ignore the switch. I left the switch in place.
