# Brief: step 3, round 2 — every browser check green (2026-09-24)

_Brief by Claude Opus 5.5 (CCc session 1997a29b, the reviewer) for Mike Wolf. Builder: Codex (seat `codex-builder`). Bead `ac-8ae`. Branch `codex/accord-click-edit` at 2ded410: your round 1 (bd53810) plus the reviewer's fixes (2ded410; read its message). Step 1 (b6577db) is live._

## Where things stand

The reviewer ran every `scripts/*-check.mjs`, twice:

- on the **live step 1 code** (b6577db): summary and logs in `/private/tmp/claude-501/-Users-mikewolf-Projects/1997a29b-9410-4709-bd9e-b513ba2b3c6a/scratchpad/s1-missing/` (the checks the step 1 release skipped) and `.../scratchpad/lv2-final/` and `.../scratchpad/lv2-rerun/` (the ones it ran, all green);
- on **your round 1** (bd53810, before the reviewer's fixes): `.../scratchpad/ce-checks/summary.txt` and one log per check beside it.

`click-edit-check` now passes 4 of 4 configurations on 2ded410. `local-write-resync-check` passed 5 of 5 runs and `marks-restart-check` 40 of 40 on bd53810. Most other failures fall into three groups. Your job is to make every check green on this branch, `npm test` too.

## The rule for deciding

"The Accord rules" (https://proof.vpsmikewolf.duckdns.org/d/gfmd0z5p; `docs/accord/rulings.md`, "The Accord rules (2026-09-24)") are agreed: nobody marks lines, and an open issue (a change one party has not accepted) is the only kind of open item. Step 1 removed the right-hand panel on that basis. So:

### A. Retired — remove what is left of it, and retire or rewrite the checks that test it

Line marks as reader work (Seen, Agreed, Approved, Rejected on lines; Agree and Reject on lines; "Agree with this section"; "Marked by N"; mark circles; "Sign in to mark"); blind marking; line tiers (decision and context, the D key, "Show only decisions"); time-to-live; "uncertain" flags; reasons, chips and objections for rejecting a line; proxy marks; Seen by dwell and the "honest reading" of scrolling; the ⋯ More menu; the right rail's box for `{do}` lines (execution is off; keep the stored data); alternatives as a separate control of stacked wordings (a proposal does that job now).

For each check: delete the assertions for retired behaviour and keep the rest. If a check tests only retired behaviour (for example `line-tiers-check`, `proxy-marks-check`, `blind-leaks-check`), delete the file and name it in your report. Never delete an assertion for behaviour that still exists: when unsure, keep it and say so.

### B. Still needed — these lived in the removed right panel; give each a home in the new layout

1. **Who you are.** "Signed in as Mike Wolf (verified)" or "guest, unverified" with a Sign in link: in the People menu and as a short label in the top bar.
2. **What a guest may do.** A guest can comment but not edit. When a guest clicks in the text or types, say so in one line with the Sign in link, and change nothing.
3. **Who added an AI.** A proposal from an AI shows "Izzy — added by Eric" on its change card in the right-hand list.
4. **An AI's reason.** The one-line Why and "Ask why" on an AI's change card, in the right-hand list. Verify it; `review-aids-check` looks for it in the old place.
5. **A stale bundle.** The warning, and the fall-back to deciding its changes one by one, in the right-hand list. Verify it; `bundles-alts-check` looks in the old place.
6. **Folding.** Collapse all, Expand all, and a section's own disclosure control must be reachable (the Outline tab and the headings). Verify; `folding-check` fails to click them.
7. **Invitations.** The flows in `invite-check` and `cross-invite-check` must still work. Where a check proved "a verified person" through a line mark, prove it with a comment or a proposal attributed to that identity instead.

### C. Real bugs — fix them

1. **Phone, live proposals: typing while someone else writes scrambles the letters.** `caret-stability-check`, configuration `caret-playmaker-suggesting-phone-390x844`: "caret stays put while others write" landed as "caret stays petut while ohers writ". Every character must land once, in order, at the caret. The check passed on the old code, so step 3 caused this.
2. **The scroll camera ignores the bottom chat.** Step 1 put the chat at the bottom of the page, but the camera still measures its band against the whole window, so a line can land behind the chat. The reading area ends above the chat. `scroll-camera-check` fails on the live code: "the band is a share of the reading area", "the cursor stays in the band and is never partially visible".
3. **`insert-suggestion-check`** fails 2 on this branch and passes on step 1: find it and fix it.
4. **Every other failure that appears only on this branch** (`comment`, `edit-gesture` (it crashes), `editing-first`, `hover-touch`, `layout`, `line-marks`, `mike-0921`, `mobile`, `reading-walk`, `usability-acceptance`, `usability-s1`, `ux-consistency`): decide for each whether it is (i) a check that assumed a click only selects a passage — under step 3 a click places the caret, so reading keys work only when the caret is not in the text (after Escape, or from the right-hand list); update the check — or (ii) a real regression; fix it. Name which, per check, in your report.

## What must not change

The server, the API, the stored marks, the marks guard and the collab protocol. `COLLAB_VERSION_POLICY.minVersion` stays 0.33.0 unless the client's writes change again. The reviewer's fixes in 2ded410 stay.

## How to work

You cannot run Chromium, so read the logs above: each check's log names the failing assertion, and most failures name the locator that timed out. Update checks and code together. Keep the Accord pattern: a policy constant, a unit test, a browser check and screenshots for each behaviour you keep or move. Run `npm run build` and `npm test`.

## Report

Your final message: per check, what you changed and why (retired, moved, fixed, or updated for click-places-the-caret); each check file you deleted; the product fixes for C1 to C3 and how you know they work; what you could not verify. Do not commit; the reviewer commits for you as `Codex <codex@openai.com>` with `Seat: codex-builder` and `Bead: ac-8ae`.
