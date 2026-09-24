# Accord usability S4a report

Bead ac-p4x. Seat grok-builder. Branch `grok/accord-usability-s4a`.

One module now computes each participant's state. The honest header and `GET /api/agent/:slug/state` both read that module.

## 1. What changed

`src/shared/participant-status.ts` is the new module. `participantStatus` at line 209 returns, for each person on the team, a state on every passage, the counts, where their reading stops, what they rejected, and whether they have finished their own review. The document result also says whether the document is aligned and whether it is agreed. Those two answers stay separate at lines 247-249. Aligned means every passage is seen by every participant and nobody rejects the current text. Agreed means every participant's every passage is Agreed. Approved does not count as Agreed.

The passage states use the spec's words, in `PARTICIPANT_STATUS_POLICY.words` at lines 27-36. The stored mark strings are unchanged. `unseen` is the word for no current Seen mark, and the policy says the interface may say "not read yet". `lapsed` is the words "agreed to an earlier version".

`markState` at lines 161-174 classifies one mark. A hidden mark is unseen. A lapsed Agreed or Approved mark is lapsed. A mark that is not current is unseen. A decayed Agreed or Approved mark counts as Seen, and it does not count as agreement. `skimmed` is unseen, because it does not count as Seen. `passageFor` at lines 177-191 treats an open objection as Rejected even when the stored line mark is Seen, and it keeps the objection's reason and its resolution condition.

A personal review is finished only when every passage is Agreed, Rejected, or Approved (`PARTICIPANT_STATUS_POLICY.decisions`, line 43, applied at line 239). Seen does not finish a review. `personalCompletionText` at line 377 returns "You have finished reviewing. Waiting for Alex and Jo." when the viewer has finished and other people have not. The names are team order, through the caller's name function. When nobody else is unfinished, the sentence is "You have finished reviewing." The sentence does not say the team has agreed, and it does not name a view. S4b is the surface that shows it. This change does not put it in the status bar.

`statusHeader` at line 350 turns that computation into the header sentences. `accordHeader` in `src/shared/open-view.ts` at line 467 calls `participantStatus` and then `statusHeader`. It no longer decides a state of its own.

The header sentence for a person with any rejection is "X rejected N lines." at `participant-status.ts` lines 315-322. That sentence does not say they have not read the text. `clauses[].lines` and `rejectedLines` are the 0-based passages the link points at. A lapsed agreement says "agreed to an earlier version of line N" at lines 324-329, instead of calling that line unread. A person who has Seen every passage and has not agreed gets "has seen it and has not agreed" at line 335. "Agreed by" at line 360 lists only people who Agreed to every passage. "Approved by" at line 361 lists only people who Approved every passage. The header is settled, and its text is empty, only when `status.agreed` is true (line 355). Approved does not settle it.

`fromLine` on a header reader is still the first passage that is not a current Agreed or Approved mark. The spoken "has not read from line N" now uses `readingStopsAt`, the first unseen passage (lines 337-341). A Seen passage before that point is no longer called unread. Someone with no Seen, Agreed, Rejected, Approved, or lapsed passage still gets "has not read it" (line 332).

The page paints those sentences in `src/ui/open-view.ts` `paintHeader` at line 366. A clause that names lines is an `<a class="aov-header-link">` (line 379). The link's `href` is `#line-N` with N 1-based. `data-lines` lists every 0-based index. A click reveals the line and calls `__proofReadingWalk.focusLine` on the first one. The plain string `header.text` is unchanged as the value tests read. The new class is in `src/ui/open-view.css` lines 80-81. No existing class or selector was renamed. The page passes open objection issues into the header at `src/ui/open-view.ts` lines 249-251, so an objection whose line mark was stored as Seen still reads as Rejected.

`server/line-marks.ts` line 335 computes the status on the decayed line states, after `evaluateExtras`. `server/agent-routes.ts` lines 2310-2314 add `body.participantStatus` on `GET /api/agent/:slug/state`. The field is new. `alignment.aligned`, `alignment.team`, `alignment.counts`, and every other existing field keep their names and their meanings. Under blind marking, `viewerParticipantStatus` at `server/line-marks.ts` line 382 recomputes from the marks that caller is allowed to see. A rejection on a line that is still hidden is not published as Rejected.

`scripts/line-marks-check.mjs` accepts `--shots <dir>`. The default directory is still `.preview`. This run passed a temporary directory, so `.preview` was not written.

Two type errors that were already in `server/agent-routes.ts` are corrected because that file is in the type-check gate. The rewrite-gate variable now uses `ReturnType<typeof evaluateRewriteLiveClientGateWithOptions>`, which is the function already imported and already called. The approve route's unused `req` is named `_req`. Neither change alters a response.

## 2. Tests

`src/tests/participant-status.test.ts` is new and wired as `test:participant-status` in `package.json`, and the `test` script runs it after `test:open-view`. It holds acceptance check 9: a person with Rejected marks is not described as unread, Seen is not listed as agreement, and Approved is named apart from agreement. It also covers an objection's resolution condition, the reading stop, a skimmed line, a decayed agreement, a lapsed agreement, and the completion sentence.

`src/tests/open-view.test.ts` keeps the thousand-document check that the Issues pill, the amber dots, and the Open list name the same lines. That check now also builds `participantStatus` and `accordHeader` from the same states and asserts they are the same object, that a rejecter's clause matches the rejection count and does not say "has not read", and that Seen and Approved are not in `header.agreed`. The old lapse assertion that said "You have not read from line 2 on" now expects "You agreed to an earlier version of line 2." The assertions for an agreed prefix ("has not read from line 4 on") and for someone with no marks ("has not read it") are unchanged.

`src/tests/honest-reading.test.ts` extends the aligned-snapshot case. After everyone has a current mark, `/state` `participantStatus.aligned` is true and `participantStatus.agreed` is false, because the human marks in that fixture are Seen. The published object equals a fresh `participantStatus` call on the same lines, marks, team, and objections. After the later Rejected mark, the header's `status` equals `body.participantStatus`, and the rejecter's clause does not say "has not read".

`npm test` exited 0. Node was v24.14.0, because this worktree's `better-sqlite3` is built for that ABI. The shell's default `node` is v22.22.3 and cannot load it. Suites that print a count: server routes 76 passed, 0 failed; line-marks 15; reading-walk 21; scroll camera 11; folding 13; asks 15; identity 15; honest-reading 23; review-aids 18; bundles 11; do 29; chat 10; editing-first 5; edit-session 10; orphans 11; proxy 13; tiers 12; dialect codec 19; dialect server 12; closed-fold 10; team invites 13; SOMA invites 7; cross-invite 19; remap 10; ux-consistency 21; mike-0921 10; layout-status 5; layout-chrome 6; layout-panels 7; threads 27; open-view 28; participant-status 8. The other wired suites exited 0 without a single total line.

`npx tsc --noEmit -p tsconfig.json` reports 487 `error TS` lines. None of them name `participant-status.ts`, `open-view.ts`, `open-view.test.ts`, `participant-status.test.ts`, `honest-reading.test.ts`, `server/line-marks.ts`, or `server/agent-routes.ts`. The previous baseline on this branch was 490. The drop is the three pre-existing errors named above (the unused `DocLine` import in `open-view.ts`, and the two `agent-routes.ts` errors). No new type error was added.

## 3. Browser checks

I ran these against the rebuilt `dist/`, with screenshots under `/tmp/accord-s4a-shots`, not `.preview`. The reviewer should run the same three. Each should still pass, and the header cases below are the ones whose words changed.

`node scripts/honest-reading-check.mjs` — 18/18 passed (playmaker and proof, desktop and phone). A spelling fix still carries marks. A later rejection still starts a new round and the bar says "Last aligned". This check does not read the new header sentences.

`node scripts/open-view-check.mjs` — 13/13 passed. The Accord header for two viewers is still "Agreed by you…" and "Eric has not read from line 4 on." when Eric agreed to the first three lines and left the rest unmarked. Eric's own header still says "You have not read from line 4 on." The zero moment still leaves the header up while someone has not read, and it still removes the header when everyone has agreed. A substantive edit still re-opens the agreement in the Open list and the margin still says "agreed to an earlier version".

`node scripts/line-marks-check.mjs` and the same command with `--style proof` — 17/17 passed in each style, desktop and phone. Agree, Reject with a reason, and the owner's Approve still set the dot. Marking every line by everyone still reaches Aligned. The document text stays clean.

What the header should show on top of those, and what these checks do not drive: a person with a Rejected mark gets "rejected N lines" as a link, and the sentence does not say they have not read it. A person who has only Seen the document gets "has seen it and has not agreed", and they are not under "Agreed by". A person who Approved every passage is under "Approved by", and the header does not go away on that fact alone.

## 4. What I did not do, and the risk

S4b still has to show `personalCompletionText` in the status bar, and it still has to make the Review count, People, and the agreed-copy gate call `participantStatus`. The functions and the `/state` field are there for that. This branch does not switch a view and does not remove a control.

The three browser checks never reject a line and then click the new header link. The link's click path is unverified in a browser. The unit tests check that the clause's `lines` are the rejected indexes.

I did not run a blind document. `viewerParticipantStatus` is the path that hides another person's rejection until the line is revealed. A hidden mark is classified as unseen, so the published status should not describe it as Rejected. That path has no new test of its own. The risk is a blind `/state` leaking a rejection reason if a future edit publishes `report.participantStatus` instead of the recomputed value.

`alignment.aligned` on `/state` is still "there are zero issues". `participantStatus.aligned` is "everyone has seen the current text and nobody rejects it". An open comment can make the first false while the second is true. A client that treats the two booleans as one fact will mis-report the document.

`nothing` on a header reader now means the person has no Seen, Agreed, Rejected, Approved, or lapsed passage. It used to mean they had no agreeing mark. The empty Open sentence uses `nothing`. A person who has only Seen marks now gets "Nothing is open for you here." rather than "You have not marked any of this yet."

An owner who Approved every passage, and never marked Agreed, does not settle the header and does not get the zero moment's "Everyone has agreed." Documents that used Approve as the owner's finish will keep the header up until those passages are Agreed. That is the ruled split between Approved and Agreed. It will look like a stuck header if a live document was finished by Approve alone.

The completion sentence is not on the page yet. When S4b shows it beside the zero moment, the zero moment can still say "Everyone has agreed" while the completion sentence does not. Both sentences would be using the rules they have now. S4b should not rewrite the completion sentence so that it claims team agreement.

I did not take the bead or write a file claim. Those stores are outside this worktree, and the instruction was to stay inside it. I did not push, deploy, or write `.preview`.

## 5. Where I think the bead is wrong, or where I chose

The bead says Seen never counts as agreement. I also treated Seen as not finishing a personal review, because a finished review is a decision on every passage and Seen is only a record of reading. If "You have finished reviewing" was meant to fire once the person has Seen every passage, `PARTICIPANT_STATUS_POLICY.decisions` is too narrow and the waiting sentence will wait on people who have already read.

The review asks for a link on the rejection count, and the reviewer note says S4b wires the interface. I put the link in the existing header element, because a pure string cannot be a link and the header is the surface the bead names. The link focuses only the first rejected line. A document with several rejected lines has the rest in `data-lines` and not as separate anchors.

`readingStopsAt` is 0-based, matching the rest of the line indexes on `/state`. The header sentence adds one when it speaks a line number to a person. A client that prints `readingStopsAt` without adding one will be off by a line.
