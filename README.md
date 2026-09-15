# Proof suggesting mode: evidence, 14–15 September 2026

_Authored 2026-09-14 by Claude Opus 5 (CCc, acting as chief of staff) for Mike Wolf; updated 2026-09-15 with the
live-check runs on builds 5b5c779 and 00c0e15._

This branch holds the browser evidence that suggesting mode works on our self-hosted Proof, at
https://proof.vpsmikewolf.duckdns.org. That server runs the fork `eldrgeek/proof-sdk`, branch `deploy/vps`.

The server now runs build `00c0e15`, deployed on 15 September 2026 at about 03:35 UTC. The sections below go in time
order: `dab0365` first, then `0b3f8dd`, then `5b5c779` and `00c0e15`. Every test used a fresh test document and
headless Chromium, driven by Playwright.

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

## Rerun on build 0b3f8dd (C4 merged)

Before C4, rejecting a suggestion through the REST API made the server rebuild its shared copy of the document. After
that rebuild, a person who had the document open lost every later edit. C4 applies the reject to the live copy
instead, and the server now logs any live update it drops.

On `0b3f8dd` both 13-step tests pass again (`run-0b3f8dd/plain` and `run-0b3f8dd/brackets`). In a separate check, an AI
rejected a suggestion through the REST API while a person was editing. The person's text from before and after the
reject was all stored, and the server stayed fresh. The server logged no rebuilds and no dropped live updates for any
of the five test documents (`run-0b3f8dd/run.log`).

## Live-check set on 5b5c779 and 00c0e15 (15 September)

From here on, one script runs every check against the build being served: `tools/run-live-checks.sh <label>`. It
records the build, creates a fresh document per check (`tools/make-docs.py`), runs each probe in `tools/probes/`, and
ends with the How-To document's health and the server-log counts (`tools/health-and-logs.py`). It never deploys. The
runs are in `live-checks/`: `baseline-0b3f8dd` (the old build), `final-5b5c779` and `integ-00c0e15`.

| Check | 5b5c779 | 00c0e15 |
|---|---|---|
| Both 13-step tests (plain and brackets) | pass | pass |
| Two people typing at once in different paragraphs, Editing and Suggesting mode | pass | pass |
| Two people typing at once in the same paragraph | text lost (local race test) | both texts kept in both modes; see the known gaps for Suggesting mode |
| An AI rejects through REST while a person edits | pass | pass |
| An AI suggestion accepted in the page while the person keeps typing | pass | pass |
| An AI writes while a person types (new check) | pass | pass |
| Tab closed 300 ms after Accept | pass | pass |
| AI format sets 1 to 3: quotes across bold, link text, a paragraph's last words plus a new paragraph | pass | pass |
| AI inserts inline, as a paragraph and as a table row, then all rejected | pass | pass |
| The same three inserts all accepted | document quarantined; it will not reopen | the same; see the known gaps |
| An AI paragraph inserted after the last block | no text landed | lands as pending text |

Every check document showed 0 rebuilds and 0 dropped live writes in the server log, and the How-To document stayed
fresh with nothing pending.

The AI-while-typing check is `tools/probes/agent-concurrent-probe.mjs`. The person types a long phrase in four bursts
with short pauses. The AI adds a replace and an insert and then rejects the replace; each call retries on
409 PROJECTION_STALE. On both builds the three calls were accepted while the person was still typing, at 3.0, 3.1 and
7.1 seconds, and nothing was lost on the page, after a reload or on the server
(`live-checks/ai-while-typing-5b5c779`, and the same check in `integ-00c0e15`). When the person types without pauses
and the AI does not retry, both AI calls get 409 PROJECTION_STALE.

Local tests on `00c0e15`: the build passes, every targeted test passes, and `npm test` passes 76 of 76. The one
failure, `collab-onstore-drift-quarantine`, fails the same way on untouched upstream `fb25787`.

## Known gaps, with fixes in progress (as of 00c0e15)

- **Accepting several AI block inserts in the page quarantines the document when one of them is a table row.**
  After inline, paragraph and table-row inserts are accepted one after another, the server lays out the table with
  columns about 131 and 135 characters wide. That trips its growth guard (201 to 1708 characters), and it quarantines
  the document. The document will not reopen, and the server still lists all three inserts as pending. The widths
  differ by 4, which is len("Producer") − len("Mike"), the new row's two cells. So the widths are probably measured
  while suggestion markup is still in those cells. Rejecting the same inserts works. Fix B8e is with a worker
  (`tools/briefs/brief-b8e-ai-block-accept-live.md`).
- **Two people typing in the same paragraph in Suggesting mode split one person's suggestion.** One person's typed
  run became six insert suggestions. Each holds three characters of content, but its range covers only two, so every
  third character (here "i", " ", "p", " " and "r") carries no suggestion mark and would skip review. Rejecting all six
  fragments, with every call returning true, left "The second act mi typ wor needs one more scene" on the page and
  in the server's copy. Three of the six rejects removed nothing, and the unmarked characters stayed. In one of the
  two runs the server also stopped being fresh (`live-checks/coverage-00c0e15`). With the two people in different
  paragraphs, every character is covered and reject-all is clean. Fix C8 is with a worker
  (`tools/briefs/brief-c8-same-paragraph-suggestions.md`).
- **Could an AI write erase a person's newest typing?** Reading the code found two places where it might: the
  save-conflict reconcile, and a keystroke that arrives while an AI mutation is being prepared. The live check has not
  reproduced a loss. Worker C7 is writing deterministic tests (`tools/briefs/brief-c7-live-typing-overwrite.md`).
- **A stray space.** After an accept in the same-paragraph case, the paragraph gains a trailing space, stored as
  `&#x20;`. This is cosmetic.

Fixed since the 14 September list: an AI's suggested insertion now keeps its text when accepted (B8, B8c), and an
AI's REST accept or reject now sticks while someone has the page open (C4b).

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
- `cursor/live-reseed-193822` (C4): a REST accept or reject on a document someone has open no longer rebuilds it,
  and the server logs any live update it drops.
- `cursor/rest-resolution-sticks-201350` (C4b): an AI's REST accept or reject sticks while the page is open.
- `cursor/rehydration-test-230502` (C4c): tests for how suggestions are restored when a page reloads.
- `cursor/ai-insert-200925` (B8) and `cursor/ai-insert-structure-225400` (B8c): AI inserts land as text, inline, as
  a paragraph or as a table row.
- `cursor/quote-anchoring-224531` (C5): AI quotes anchor on visible text, across bold, on link text and at a
  paragraph's end.
- `cursor/concurrent-typing-225401` (C6): two people typing at once no longer send each other's caret to the end of
  the document.
- `cursor/same-paragraph-race-010042` (B2d) and `cursor/fragment-dirty-012325` (B2e): when two people type in the
  same paragraph, both texts are saved.
- `cursor/ai-block-accept-011611` (B8d): an AI paragraph inserted after the last block lands.
- `integ/2026-09-15-00c0e15`: the build as verified, before `deploy/vps` moved to it.
- `deploy/vps`: all of the above, merged (`00c0e15`). It is what the server runs.
