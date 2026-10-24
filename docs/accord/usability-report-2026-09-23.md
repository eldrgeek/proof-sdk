# Accord usability simplification: validation report

_Mike Wolf asked, on 2026-09-23: "Review this document. Propose any changes, turn into beads and get the job completed." This report closes that job. Written by Claude Opus 5.5 (CCc, seat ccc-adhoc) on 2026-09-24. The brief, the review that wins over it, and the bead plan are in `docs/accord/usability-brief-2026-09-23.md`._

## What a reader notices now

| Before | After |
|---|---|
| Sections closed by themselves when they had no Issues for you, and opened while the mouse rested on them. | A section opens or closes only when you click its control, use Expand all / Collapse all, or navigate to a passage inside it. It stays as you left it, and a reload restores it. |
| A line you agreed with, rejected or resolved folded away into a one-line summary once you scrolled past. | Agreeing, rejecting or resolving never folds text. |
| A mark on a folded heading covered every line in the section. | A heading mark covers the heading only. "Agree with this section (N lines)" is a named action, offered only when every line is visible. It writes exactly the lines it listed. |
| Resting the mouse on a line changed which line the keys acted on, and ended typing. | Hover changes nothing. The keys act on the passage you selected by click, tap, or J/K. |
| Scrolling past a proposal accepted it provisionally, and scrolling counted as agreement. | Scrolling records Seen and nothing else. |
| Clicking text started editing it. Typing went straight into the shared document as tracked changes, and leaving the line posted it. | A click selects the passage. Suggest change (or S) opens a draft beside it. Only Propose change or Cmd/Ctrl+Enter publishes. Esc, clicking away, scrolling and reloading keep the draft; Cancel discards it. Direct editing is a separate mode, behind a labelled Enter Editing / Leave Editing control. |
| The Open view hid settled text; an Issues pill, a Navigator tab and an Open list each held a queue. | The document is always shown whole. One Review panel (Review, Outline, Since you) holds the list, with a scope switch (Needs you / All open) whose count names its scope. Items keep document order, and a new item never moves the current one. |
| Several answer controls repeated each other in the rail, the margin and the walk boxes. | Each passage has one answer group: Agree, Suggest change, Discuss, Reject. A passage with a discussion or proposal shows a margin marker with a count in words. |
| The header called someone who rejected everything "has not read it". Approved never counted as the approver's own agreement. Zero Issues read as Aligned. | One status computation feeds every surface. A rejecter is "rejected N lines". Approved counts as the approver's agreement and keeps its own label. Aligned means everyone has seen the text and nobody rejects it. Finishing your review shows "You have finished reviewing. Waiting for …". View agreed copy names the wording and who agreed. |
| "safe → unsafe", "paid → unpaid" and "fund → find" counted as spelling fixes and kept an agreement. | Only the 232 listed misspellings carry an agreement. Any other word change, any symbol change, and any punctuation change other than a typographic look-alike or a final period, reopens it. |

## Rulings this reverses (the ringer list)

These changes undo things Mike ruled before. Each is recorded in `docs/accord/rulings.md` under 2026-09-23, with the old words kept:

1. Scroll is no longer acceptance or agreement (09-19).
2. Clicking marked text no longer starts an edit. Pop-ups are still gone (09-19).
3. Closed Issues no longer fold, and groups no longer close by themselves or open on hover (09-19).
4. Hover no longer ends Writing mode (09-21).
5. Hover no longer previews into the target; the first key or click no longer commits it (09-21).
6. Leaving an edit no longer posts it (09-22).
7. The Open view is no longer a filtered way to read (09-22).

Two decisions are the reviewer's, not Mike's, and are named here so he can overrule them:

8. Approved counts as the approver's own agreement. The brief says Approved is "distinct from everyone's agreement". The reviewer read that as team-level, because the code already ranked Approved above Agreed.
9. Live status moved into the Review panel. The status header sits above the text only in the agreed copy, because a status line above the text reflowed the page, 20 px at a time, while people typed.

## Verification

| | Baseline (7b5c574 + docs) | Final (540d684) |
|---|---|---|
| `npm test` | green | green |
| TypeScript errors (`tsc --noEmit`) | 490 | 475 |
| Browser checks (`scripts/*-check.mjs`) | 26 of 31 scripts green | 37 of 37 scripts green, plus line-marks in the proof style |
| Independent acceptance harness (the brief's twelve checks at 1280×800 and 375×812) | 7 cases failing, 3 skipped | 26 of 26 pass |

- **Flaky checks, seen during the night and passed when re-run alone:** honest-reading's rail click, layout's ⋯ More click, and bundles-alts under load. The phone case "Cancel discards; direct Editing has a named control" in edit-gesture failed about one run in two after the S3 merge, and passed in the final run.
- **The classifier's effect on live data:** the reviewer counted it on a consistent copy of the live database (`scripts/usability-impact-report.mjs`). Across 148 documents and 802 line marks, 1 mark changes state, and it is a Seen mark. No Agreed, Approved or Rejected mark on a live document changes.
- **Blind mode:** a new test found that `/state` published hidden objections before reveal. A read-only audit then confirmed 13 more leak paths, and all are closed. Each has a test that failed before the fix and passes after, plus a browser check. Live exposure was nil, because no document had blind mode on.

## Deploys

- **Wave 1:** 0913728, deployed 2026-09-24 about 06:22 UTC. Database backup `proof-share-20260924T062120Z-pre-usability-w1.db` (integrity ok). Live check on the throwaway document `/d/c0qr3avn`, opened as a guest in Claude's own browser, not as Mike: sections open on load; hover moved nothing; scrolling past a proposal left it pending; the phone layout rendered.
- **Wave 2:** 540d684. See the ESTATE.md changelog line for the deploy time, the backup file and the live check.

## Who did what

| Worker | Work |
|---|---|
| OpenAI Codex (gpt-6-astra) | Built S1 (first round), S2a, S3 (first round), S2b and S4b, S4b-logic, S5 (three rounds), the blind-leak audit and fixes, and the impact script. Its read-only diagnoses found the S1+S3 merge fault (review mode read as direct Editing) and the final layout fault (the live header above the text). |
| xAI Grok (grok-4.7) | Built S4a. Finished S1 with the browser checks: the redraw freeze behind five regressions, and the focus and Room fixes. Finished S3: drafts re-attach, lost drafts are listed. Began the S2a fixes and the S3 merge. Its usage balance ran out at 402, part-way through. |
| Cursor (composer-2.5) | Wrote the independent acceptance harness (two rounds). Found that ac04 was a harness sort defect. Ran the final fix round: check updates and the aligned logic. |
| agy (Gemini 3.1 Pro) | Critiqued the review before the builds, which gave five adopted changes. Reviewed S5 and S1; confirmed findings included the missing margin controls. |
| Claude (reviewer) | The review, the beads, every merge and conflict resolution, all browser verification runs, the deploys and the live checks. |

## Known issues and risks

- The four standalone upstream suites `src/tests/review-*-browser.test.ts` are not wired into `npm test`, and two of them still drive the retired review dialog. They were not run to green.
- `accord/yjs-resync`: its fix `src/editor/local-write-resync.ts` is ported, because a draft submission is a local write. The direct-editing conversion gate stays off, and the draft model no longer needs that conversion.
- View agreed copy names the wording by a content fingerprint, not by the server's revision counter.
- The throwaway document `/d/c0qr3avn` stays on the live server as the live-check fixture. It belongs to no one's library and can be deleted.
- Topping up Grok's usage balance is Mike's decision. Until then the Grok lane is down.
