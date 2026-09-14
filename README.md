# Proof suggesting mode: evidence, 14 September 2026

_Authored 2026-09-14 by Claude Opus 5 (CCc, acting as chief of staff) for Mike Wolf._

This branch holds the browser evidence that suggesting mode works on our self-hosted Proof, at
https://proof.vpsmikewolf.duckdns.org. That server runs the fork `eldrgeek/proof-sdk`, branch `deploy/vps`.

The tested build is `dab0365`, deployed on 14 September 2026 at about 19:57 UTC. Every test used a fresh test
document and headless Chromium, driven by Playwright.

## Result

Both 13-step browser tests pass on `dab0365`, with no errors in the page console:

- `run-dab0365/plain` uses plain text.
- `run-dab0365/brackets` uses text with markdown brackets, which used to break accepts.

Each test types in Suggesting mode, reloads, sees the suggestions, and then accepts and rejects them. Each test
ends by reading the server's own view of the document. In both runs that view was fresh, at revision 12, with no
pending suggestions and no markup inside the text.

The screenshots are numbered in step order, and `summary.json` records the result of every step.
`run.log` is the full console record of the run, including the probes described below.

| Step | What it checks | Plain | Brackets |
|---|---|---|---|
| 1 | A fresh document opens in Suggesting mode | pass | pass |
| 2 | Text typed key by key is underlined green and credited "Suggested by Claude E2E" | pass | pass |
| 3 | A deleted word is struck through in red | pass | pass |
| 4 | After a reload, both suggestions are still there and still drawn | pass | pass |
| 5 | Clicking the insertion opens a card with the author and the change | pass | pass |
| 6 | Accepting the insertion keeps the text and removes the suggestion | pass | pass |
| 7 | Rejecting the deletion keeps the word | pass | pass |
| 8 | After a reload, the accept and the reject are both still in effect | pass | pass |
| 9 | Accepting a deletion removes the text exactly once, including after a reload | pass | pass |
| 10 | The review button counts two new suggestions | pass | pass |
| 11 | Reject all removes the inserted text and keeps the word it would have deleted | pass | pass |
| 12 | Accept all keeps the new text | pass | pass |
| 13 | After a final reload, the text is exactly what was accepted and nothing is pending | pass | pass |

## Probes (in `run.log`)

- **Accept, moment by moment.** Accepting a typed insertion removed the suggestion in the same instant. It
  stayed removed at 0.1, 0.5, 1, 2, 4 and 8 seconds.
- **Tab closed 300 ms after Accept.** The tab made no REST calls. The server's copy was fresh, the words were
  stored once, and nothing was pending. A new reader saw no pending suggestion.
- **Tab closed immediately after Accept.** The accept was stored, and a new reader saw it correctly. The server
  briefly reported its copy as stale, with a repair pending. About five minutes later it had repaired itself, and
  the copy was fresh at revision 3. The previous build showed the same brief staleness.

## The three deliverables

**(a) Suggestions are drawn and credited.** Pending insertions are underlined green, and deletions are struck
through red. Each suggestion names its author. Steps 2 to 5 show this.

The cause of the old failure was specific. Typed suggestion text was inserted and then removed in the same instant,
because a forced re-render of the collaborative document ran while the hydration check saw a mismatch. Fixes A and
A2 stop that. B2a keeps the authorship marks and the suggestion's content correct while you type.

**(b) Accept and Reject work, one at a time and all at once.** Steps 6 to 13 show this. The fixes that make it
work are B, B2b, B3, B4, B5, B6 and B7:

- B puts the card and the review button in shared documents.
- B5 accepts an insertion without re-inserting its text, and adds a server guard against storing markup as text.
- B6 marks a suggestion resolved before the change goes out, and never reloads live text during recovery.
- B7 sends Accept and Reject in a live session as ordinary collaborative edits. It uses the REST API only when the
  page is disconnected.

**(c) The stale projection on large documents is not about size.** The stored markdown was not what the editor
would itself produce (`- ` bullets came back as `* `, and tables were padded). So the server saw its stored copy and
the live copy disagree forever, reported the projection as stale, and refused AI suggestions with HTTP 409.

The fix is three parts:

- Every's open pull request #65 normalizes the stored markdown. It is cherry-picked as fix C.
- C2 is a lossless repair for documents that are already stuck.
- C3 fixes accepting text that contains markdown characters.

No setting fixes it, because the projection repair never rewrites the stored markdown. Before the fix, a fresh
document made from the How-To's original markdown was stale from the start, and an AI suggestion returned 409. After
the fix, the same test was fresh, and the suggestion returned 200.

## Known limitation, with its fix in progress

If an AI agent rejects a suggestion through the REST API while a person has the document open, the server rebuilds
its shared copy of the document. After that, the person's later edits are not stored. People's own Accept and Reject
in the browser no longer take that path, because of B7.

A fix is in progress as C4. It stops the rebuild for a document someone has open, and it makes the server log any
update it drops.

## Branches in the fork

- `suggest-toggle`: the Editing and Suggesting switch.
- `cursor/suggest-text-lost-170421` (A) and `cursor/kick-guard-171452` (A2).
- `cursor/share-accept-reject-170443` (B), `cursor/typing-integrity-175637` (B2a),
  `cursor/share-hardening-175705` (B2b) and `cursor/anchor-metrics-175956` (B2c).
- `cursor/accept-local-first-181455` (B3), `cursor/share-convergence-183216` (B4),
  `cursor/accept-insert-185745` (B5), `cursor/tombstone-order-191626` (B6) and
  `cursor/collab-resolution-193820` (B7).
- `cursor/projection-stale-170505` (C, which is PR #65 plus a list-marker test),
  `cursor/heal-equivalence-175929` (C2) and `cursor/accept-escaping-182946` (C3).
- `cursor/legacy-create-170543` (D) and `cursor/create-auth-171017` (D2): `POST /documents` creates documents
  again, and it requires the API key.
- `cursor/selfhost-docs-170832` (E) and `cursor/docs-fixes-171653` (E2): the self-hosting settings guide.
- `deploy/vps`: all of the above, merged. It is what the server runs.
