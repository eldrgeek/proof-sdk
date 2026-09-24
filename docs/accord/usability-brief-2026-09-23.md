# Accord usability simplification: brief, review and work plan (2026-09-23)

_Brief by OpenAI Codex (ChatGPT Desktop), 2026-09-23, at Mike Wolf's request, after Mike reported that opening and folding cause confusing, unexpected changes. Review, changes and bead plan by Claude Opus 5.5 (CCc, seat ccc-adhoc), 2026-09-23, on Mike's instruction: "Review this document. Propose any changes, turn into beads and get the job completed."_

Read the "Review and changes" section first. Where it differs from the brief below it, the review wins. The brief itself is kept word for word at the end of this file.

## Review and changes

### 1. Authority

Mike's instruction of 2026-09-23 makes this brief the target for this work. So the brief's lines that call it "not ratified" and say "do not deploy under this brief alone" are replaced, for the reviewer only. The reviewing Claude session merges the stages, backs up the database, deploys, and checks the live site after the acceptance checks pass.

Workers (Codex, Cursor, any worker session) still never push to `deploy/vps` or `main`. Workers never deploy, never touch the VPS, `~/proof-data`, keys or mail, and never write to a live document.

### 2. The rulings this work reverses

Each reversal below is recorded in `docs/accord/rulings.md` under "2026-09-23". The old lines stay there, marked superseded, so the history reads correctly.

| Old ruling | Date | What replaces it |
|---|---|---|
| "When an issue is closed by a user, it should be folded for that user." | 09-19 | Closing an Issue never folds document text. |
| "A group with no Issues closes; hover opens it." | 09-19 | A section opens or closes only by its disclosure control, Expand all / Collapse all, or navigation to a passage inside it. |
| "Scroll is acceptance and agreement, provisional until the next deliberate action." | 09-19 | Scrolling records Seen and nothing else. It never accepts a proposal and never records agreement. There is no provisional state. |
| "Resting the mouse on another line ends Writing mode once typing has paused." | 09-21 | Hover never changes the mode, the target, the selection or the layout. |
| Layout stage 3: "one cursor: hover previews, the first key or click commits". | 09-21 | The target is the passage the reader selected, by click, tap or J/K. Hover may show a tooltip and nothing else. |
| Edit gesture: "leaving an edit posts it; a click outside and Esc are doors". | 09-22 | Only Propose change, or Cmd/Ctrl+Enter, publishes. Leaving keeps the draft. Cancel discards it. |
| The Open view shows "only unsettled material, with context" as a way to read. | 09-22 | The document is always shown whole. The Open list becomes the Review list beside it. |
| "Clicking marked text must just edit, Docs-like." | 09-19 | Half kept: there are still no review pop-ups. Half changed: a click selects the passage, and editing starts from Suggest change, in an inline draft. |

These rulings stay exactly as they are:

- Assent is bracketed: explicit marks on two lines imply Seen on the lines between them, not agreement.
- Agreed is personal. Approved is the owner's binding ruling.
- Aligned (everyone has seen the text and nobody rejects it) is weaker than agreed (everyone agrees).
- A thread and a proposal are one object.
- There is one definition of Open.
- Mike's open question "are unread lines Open?" stays open, with the current default (`unreadLinesAreOpen = false`).

### 3. Keep Mike's words for the states

The brief names five states. The spec already has names for them, and Mike ruled on those names, so the interface uses the spec's words:

| Brief's word | Spec's word, used in the interface |
|---|---|
| Unreviewed | unseen (the interface may say "not read yet") |
| Seen | Seen |
| Agreed | Agreed |
| Objected | Rejected (a Rejected mark keeps its reason and its resolution condition) |
| Approved | Approved |

A sixth state already exists and stays: an agreement whose line has since changed in substance shows as "agreed to an earlier version".

No stored value, field name or API value is renamed.

### 4. The draft model (settles the brief's section 5)

- In the ordinary review flow, nobody types straight into the document text. A click or a tap selects one passage. A passage is the unit the marks already anchor to: a paragraph, a list item or a heading. The blue highlight shows exactly that unit. Selecting a phrase inside a passage still works, so a reader can discuss a phrase.
- **Suggest change** opens an inline draft below the passage, prefilled with its text. The shared document is not written while the reader drafts. The key S opens the draft for the selected passage. (E is already taken: it starts an Explain thread.)
- **Propose change**, or Cmd/Ctrl+Enter, writes one proposal in one transaction. The proposal is attributed to its author, and one Undo removes it.
- Esc, a click elsewhere, scrolling, hovering, leaving the page and reloading all keep the draft. The passage then shows "Draft · Resume · Discard". Drafts are stored in the browser, per document, per passage text and per reader.
- **Cancel** discards the draft.
- Direct editing stays for the people the existing permission rules let edit. It is the existing Editing mode. It is entered and left through one clearly labelled control, and the status bar names it while it is on. Letter shortcuts are off while it is on. `EDIT_SESSION_POLICY.convertDirectEditsToProposals` stays false.
- Suggesting mode, as a way of typing tracked changes into the text, leaves the ordinary review flow. Suggestions already in documents keep working and are read as proposals, with no migration. The agent HTTP routes are unchanged.
- A submission is one local write to the shared document. The draft stage adds a browser check in which a second participant edits the same passage while the draft is submitted. If the document duplicates, the stage adopts `src/editor/local-write-resync.ts` from branch `accord/yjs-resync` (b8a7c97), keeps the direct-editing gate off, and runs that branch's `scripts/local-write-resync-check.mjs`.

### 5. Folding and navigation (settles the brief's section 1)

- On first open every section is expanded. After that, the reader's own open and closed choices are stored per document and per reader, and a reload restores them.
- Closed-Issue line folding (`CLOSED_FOLD_POLICY`, `src/ui/closed-fold.ts`) leaves the interface. Its code and tests are removed or reduced to what the resolved-history entry needs.
- A mark on a heading applies to the heading line only, folded or not (`FOLDING.foldedHeadingScope` becomes `'heading'`). Marking a whole section stays possible only through one explicitly named action, "Agree with this section (N lines)". That action writes exactly the lines it listed when the reader chose it, identified by their text, and never includes lines added in the meantime.
- Navigation from the Review list, Next, a search, a link or an anchor may open the sections that contain its target. It never closes any section.
- J and K step between visible passages. A collapsed section is one stop: its heading.

### 6. The Review list (settles the brief's section 2)

- The toolbar holds the document title, then **Review** (with a count), **People** and **Share**. The Review list replaces the Issues pill's queue, the Navigator's Issues tab and the Open list.
- On a desktop the Review list is one side panel with three tabs: Review, Outline and Since you. On a phone the same list is the existing bottom sheet. The Review button opens and closes the panel, and the panel's open or closed state is remembered per reader.
- The list has a scope switch: "Needs you" or "All open". The count always names its scope, for example "3 need you" or "12 open". Both scopes use the one definition of Open in `src/shared/open-view.ts`.
- Selecting an item opens the sections that contain it, selects its passage, keeps the passage in view without animation, and shows its proposal or discussion in the panel. That panel is the one place an item's detail appears.
- Completing an item marks it done in place. It stays until Next, Clear completed, or the panel closes. New items raise the badge and are added to the end, without reordering around the current item and without moving focus.
- Each selected passage has one set of answer controls: Agree, Suggest change, Discuss, and Reject (which keeps its reason and its resolution condition). The duplicate answer controls in the rail, the margin and the reading-walk boxes go.

### 7. Status (settles the brief's section 6)

- One shared module computes each participant's state per passage and per document. The server's `/state`, the honest header, the status bar, the Review count, People and the agreed-copy gate all read that one module. The existing test that says the Open views "cannot disagree" is extended to all of them.
- The header never calls someone "has not read it" when they have a Rejected mark. It says how many lines they rejected, with a link to them.
- Finishing a personal review shows a status such as "You have finished reviewing. Waiting for Alex and Jo." It never claims team agreement. It does not switch views and does not remove controls.
- When the agreement requirement is met, the page offers **View agreed copy**, which is the existing Accord view. It names the revision and the people who agreed. A later substantive change reopens the affected agreement and keeps the earlier record.
- Accepting a proposal changes the text under the existing authority rules. It never records anyone else's agreement.

### 8. The change classifier (settles the brief's section 6, last paragraph)

Today `safe → unsafe` and `paid → unpaid` count as spelling fixes in any line of about 20 letters or more, so an agreement carries across a change of meaning. The rule after this work:

- A changed word counts as a spelling fix only when all of these hold:
  - the change is one edit: an insert, a delete, a substitution, or a swap of two neighbouring letters;
  - the first letter is unchanged;
  - both words are at least four letters long;
  - neither word is the other with a negating or opposing affix added or removed. The prefixes are un, in, im, il, ir, non, dis, mis, a, anti, counter and de. The suffixes are -less and -n't.
- The existing rules stay: a changed number, a meaning word, a name, and a moved word are all substantive.
- A sentence that gains or loses "?" or "!" is substantive.
- The tests must cover `safe → unsafe`, `paid → unpaid`, `legal → illegal`, `able → unable`, `increase → decrease`, `hire → fire`, `accept → except`, `male → female`, a changed amount, `shall → may`, and "We ship Friday." → "We ship Friday?". All of these must be substantive.
- The tests must also cover whitespace, case at a sentence start, `recieve → receive`, `seperate → separate` and `accomodate → accommodate`. All of these must stay cosmetic.

Whether a mark carries over is computed at read time from the stored anchor text. So stored mark rows are never changed. Under the stricter rule, a few marks that carried before will show as "agreed to an earlier version". That is the correction the brief asks for, and it rewrites no past consent. Before deploying, the reviewer counts, on a copy of the live database, how many marks change state.

### 9. Not in this pass

- Remapping keys. One on/off setting for letter shortcuts meets the brief.
- Sentence-level anchoring.
- A new whole-document "Agree with this version" action.
- The room scribe, a conversation-first landing, a replacement editor, and anything else `docs/accord/rulings.md` lists as not to be started.

### 10. Branches, beads and evidence

- The integration branch is `accord/usability` (worktree `~/Projects/.fleet-wt/accord-usability`). It is cut from `codex/accord-fresh-view` (ca55f35), which is `origin/deploy/vps` (7b5c574) plus `AGENTS.md`, `docs/accord/` and the guidance-sync test. Those guidance commits ship with this work.
- Each worker stage runs on its own `codex/accord-usability-<stage>` branch cut from the current `accord/usability`. The reviewer merges it back after the suites and checks pass.
- The beads live in `~/Projects/_estate/beads/proof-sdk` (prefix `ac`). That store was created on 2026-09-23 for this job, so proof-sdk is now in the beads pilot. Every commit carries `Bead: <id>` and `Seat: <seat>`.
- Baseline on `accord/usability` before any change: `npm test` is green, and the type-error count and browser-check results are recorded in the validation report.
- Final evidence: a walkthrough on a local fixture at 1280×800 and at 375×812, with screenshots in `.preview/usability/`. The report is `docs/accord/usability-report-2026-09-23.md`.

## The work as beads

Mike, later on 2026-09-23: "We also have Grok, Cursor, agy, others." So the plan runs four vendors in parallel instead of one queue. S3 no longer waits for S1, because it replaces every edit door anyway. S4 is split: its logic (S4a) starts now, and its interface wiring (S4b) waits for S2 and S3. An acceptance harness written by a different model (S6a) checks all the builders.

| Stage | Bead | What | Who | Depends on |
|---|---|---|---|---|
| S0 | ac-069 | Integration branch, baseline, this review, guidance (done) | Claude (reviewer) | — |
| S1 | ac-zhv | Nothing changes the view unless the reader does it: folding, fold scope, hover, viewport, scroll never commits | Codex (gpt-6-astra, high) | S0 |
| S2 | ac-q3j | One Review list beside the full document | next free builder | S1 |
| S3 | ac-nkn | Proposals are drafts until the reader presses Propose | Codex (gpt-6-astra, high) | S0 (built beside S1, merged after it) |
| S4a | ac-p4x | The status model: pure module, server, header | Grok (grok-4.7) | S0 |
| S4b | ac-54j | The status model wired into the interface | next free builder | S2, S3, S4a |
| S5 | ac-evq | A spelling fix never carries agreement across a change of meaning | Codex (gpt-6-astra, medium) | S0 |
| S6a | ac-3g7 | An independent acceptance harness for the brief's twelve checks | Cursor (composer-2.5) | S0 |
| S6 | ac-o3l | Acceptance walkthrough on desktop and phone, validation report | Claude (reviewer) | S4b, S5, S6a |
| S7 | ac-c9t | Deploy, live check, changelog | Claude (reviewer) | S6 |

Before a stage merges, agy (Gemini 3.1 Pro) reviews its diff against this document, and the reviewer runs the suites and the browser checks. Grok works as seat `grok-builder`, registered for this job.

The bead ids are in the store (`~/Projects/_estate/bin/bead --repo proof-sdk list`).

---

## The brief, as Codex wrote it (unchanged)

# Accord: usability simplification brief

Prepared for Mike Wolf by Codex, 23 September 2026, from a read-only review of the Accord code, recent history, saved screenshots, and Mike's report that opening and folding cause confusing, unexpected changes.

## Objective

Make Accord predictable enough that someone can read, propose wording, discuss disagreements, and reach agreement without learning hidden interaction rules.

The central design rule is: **the document stays where the reader left it until they deliberately change the view. Settled discussion becomes quieter; document text does not disappear because a decision was made.**

Preserve Accord's purpose: humans and AIs conduct a conversation around wording and leave an agreed document behind. Keep proposals, anchored discussions, dissent, provenance, and agreement history. This work simplifies how people use those capabilities.

## Status and context for the implementing agent

Mike requested this implementation brief after a usability proposal. This file describes the proposed work; it is not evidence that each replacement rule has already been separately ratified. When assigned implementation, use these rules as the proposed target for a reviewable local branch. Do not deploy or modify live documents under this brief alone.

Several proposals deliberately revise earlier interaction decisions: automatic folding, hover opening, scroll-based assent, and posting edits when focus leaves. Make those revisions explicit in the handoff. Do not silently restore the old behavior merely because an old policy comment or regression test encodes it. Equally, do not present these new proposals as historical rulings by Mike.

An important correction to the initial audit: the September 19 spec intentionally distinguishes **aligned** (everyone has seen the text, with no rejection) from **agreed** (everyone has agreed). Preserve the distinction and any documented exceptions. The problem is inconsistent presentation and computation, including a header that calls a person unread when they have explicitly rejected the text. Do not collapse every state into a single consensus boolean.

### Locate the right code

- Repository: `/Users/mikewolf/Projects/proof-sdk`. Its main checkout is upstream Proof, not Accord. Do not implement there.
- Last locally inspected deployment reference: `origin/deploy/vps`, commit `7b5c574`.
- Reviewed Accord working copy: `/Users/mikewolf/Projects/.fleet-wt/accord-mail`.
- Newer agent documentation: `/Users/mikewolf/Projects/.fleet-wt/accord-codex`, branch `codex/accord-fresh-view`, inspected at `ca55f35`. Its changes above `7b5c574` are agent guidance/spec snapshots and a guidance-sync test.
- Read `/Users/mikewolf/Projects/START-HERE.md`, `/Users/mikewolf/Projects/AGENTS.md`, and the current Accord `AGENTS.md`. Read `docs/accord/README.md`, `docs/accord/rulings.md`, and the spec/layout snapshots referenced there. Recheck branches, claims, and concurrent work before editing.
- Work in an isolated branch from the current Accord integration baseline. Preserve other working copies and their uncommitted files.
- A separate branch, `accord/yjs-resync` at `b8a7c97`, proposes a fix for concurrent-edit duplication. Determine whether it has since landed. Do not blindly merge it or enable the gated direct-edit conversion; follow the current validation requirements.

## Proposed interaction contract

### 1. One predictable folding model

Disable automatic section closure, automatic folding of completed paragraphs, and hover-to-expand/re-collapse.

A section opens or closes only through its disclosure button, a clearly named bulk view command, or deliberate navigation to a passage hidden inside it. Navigation may reveal the required ancestors; it must not fold other sections. Once opened, a section stays open until the reader closes it. Keep these choices per reader and document.

Provide **Expand all sections** and **Collapse all sections**. These affect section visibility only. Discussion history has its own explicit **Show discussion** control.

Agreement, rejection, accepting a suggestion, receiving a comment, or finishing a review must not fold document text. If the currently displayed discussion resolves, update its status in place. When the reader leaves and returns, it can appear as a compact resolved-history entry.

Preserve the passage's viewport position when layout changes above it. Never move the caret or selection because another person creates a mark or a review counter changes. A remote edit may necessarily change text; it must not automatically navigate the reader or open panels.

### 2. A full document with one review list

Default to the complete document. Replace Open's automatic filtering of document text with an optional **Review** list beside the document.

The primary controls are **Review**, **People**, and **Share**, alongside the document title. Keep an outline available without requiring another permanently open column. Consolidate the overlapping Issues/Marks queues and duplicate answer controls.

The review list has an explicit scope, **Needs you** or **All open items**. A count always names that scope. Selecting an item reveals and selects its passage, then shows its proposal or discussion in one place. On a phone, use the same actions in a deliberate drawer or sheet.

Completing an item marks it done in place. It stays until **Next**, **Clear completed**, or leaving the review session. Incoming items update a badge and are added without reordering the current item or stealing focus.

Do not add a second condensed-document mechanism in this pass. If an excerpt view is retained for compatibility, make it explicitly chosen, label omitted text as hidden rather than agreed, and provide **Show in document**. It must not stack independent folding rules.

### 3. Stable targets and clearly scoped actions

Select a passage, then offer **Agree**, **Suggest change**, and **Discuss**. Preserve a visible way to record disagreement, including the existing reason and resolution-condition data. A replacement is helpful but must not be required merely to register an objection.

Hover may reveal a tooltip or action affordance. It must not change the action target, keyboard target, selection, or page geometry. Actions operate on the explicitly selected passage shown in the interface.

Never let folding change agreement scope. **Agree with this section** and **Agree with this version** are distinct, explicitly named actions. They show the scope and operate on the exact revision presented; a concurrent change must not silently expand their effect.

Use the existing supported anchoring granularity for the first implementation and label it accurately. Do not claim sentence-level agreement if the operation marks an entire paragraph. Splitting prose into atomic claims is separate work.

### 4. Reading does not commit a decision

Remove scroll-to-agree, scroll-to-accept, and the later-action commit of earlier provisional accepts from the default workflow. Reading progress, if retained, is separate from assent and never displayed as proof that someone agreed.

Keep rapid review through explicit actions and optional shortcuts. A shortcut must have one visible target and work identically whether surrounding sections are folded or expanded. Letter-only shortcuts must be disableable or remappable and must not run while someone types or uses speech input in an editor or field.

### 5. Editing has an explicit submission step

**Suggest change** opens an inline draft with **Propose change** and **Cancel**. Cmd/Ctrl+Enter may submit. Clicking elsewhere, hovering, scrolling, or pressing Escape must not publish. Preserve an unsubmitted draft with a visible way to resume it; Cancel explicitly discards it.

Avoid parallel, ambiguous Editing/Suggesting and Reading/Writing modes in the ordinary review flow. If direct editing remains for authorized users, make it clearly separate and preserve its permission rules.

This likely requires genuine draft state. Do not simulate a private draft by writing shared text and undoing it later: that interacts with the known concurrent-edit defect and may expose unfinished wording.

### 6. Honest status and completion

Use shared domain rules for backend reports, review counts, per-person status, and completion displays. Different views may filter the same facts; they must not invent different meanings.

Keep these distinctions clear:

- Unreviewed: required review has not been recorded.
- Seen: reading/review recorded, without claiming explicit agreement.
- Agreed: this participant endorses the specified current wording.
- Objected: unresolved disagreement, never mislabeled unread.
- Approved: an authorized owner's ruling, distinct from everyone's agreement.

Accepting a suggestion changes the draft under the existing authority rules. It does not automatically grant other participants' agreement. A document with all required Seen marks may be aligned under the established policy without being unanimously agreed.

Finishing review updates a persistent status, such as **You have finished reviewing. Waiting for Alex and Jo.** It does not switch views or remove controls. Once agreement requirements are met, offer **View agreed copy**, identifying the version and participants. Later substantive changes reopen affected agreement while preserving the earlier record.

Correct unsafe agreement carry-over: the existing classifier calls `safe → unsafe` and `paid → unpaid` cosmetic in ordinary sentences. Do not allow spelling distance alone to preserve endorsement. Prefer re-review when equivalence is uncertain. Preserve historical marks; do not rewrite past consent.

## Implementation order and code map

Deliver cohesive, reviewable stages rather than adding more independent policy switches.

1. **Stability:** remove automatic folding and hover side effects; fix fold-dependent agreement scope; preserve selection and viewport. Start with `src/shared/folding.ts`, `src/shared/closed-fold.ts`, `src/ui/folding.ts`, `src/ui/closed-fold.ts`, `src/shared/layout-panels.ts`, and the reading/scroll UI.
2. **Simpler workflow:** consolidate the review list; make navigation non-committing; add explicit draft submission. Inspect `src/shared/open-view.ts`, `src/ui/open-view.ts`, `src/ui/navigator.ts`, `src/ui/line-marks.ts`, `src/ui/threads.ts`, `src/shared/reading-walk.ts`, `src/ui/reading-walk.ts`, `src/shared/reading-keys.ts`, `src/shared/edit-session.ts`, and `src/editor/editing-guard.ts`.
3. **Consistent status:** reconcile presentation with the established agreement model and fix unsafe carry-over. Inspect `src/shared/line-marks.ts`, `src/shared/line-change.ts`, `src/shared/alignment.ts`, and their server counterparts. Regression-test agreement behavior throughout earlier stages as well.

Reuse the editor, collaboration runtime, APIs, identity, permission, and export infrastructure. Preserve existing documents, marks, objections, histories, and AI access. Advanced proxy, tier, expiry, and action features can remain outside the primary flow. Do not build a room scribe, a new landing experience, or a replacement editor as part of this work.

## Acceptance checks

Verify with local fixtures on desktop and phone, using mouse, keyboard, and touch where supported:

1. Scroll away from an expanded section, pause, and return: it is still expanded. Hovering another section changes no layout.
2. Agree, reject, or resolve an item: its passage remains visible and the viewport stays anchored.
3. Collapse a section and use a passage action: no hidden text is implicitly included. Explicit section agreement names its scope.
4. Hover another passage and press a shortcut: the explicitly selected target remains the target.
5. Scroll past proposals and click elsewhere: no proposal is accepted and no agreement is recorded.
6. Type a proposed edit, scroll, switch focus, and press Escape: nothing is published and the draft is recoverable. Submit once: one attributed proposal appears; Undo behaves correctly.
7. A second participant adds a comment or edits elsewhere: no panel opens, section unfolds, list reorders around the current item, or focus moves unexpectedly.
8. Resolve the final review item: status updates; the current view and controls remain available.
9. Seen, Agreed, Objected, and Approved produce accurate labels. Nobody who rejected text is described as not having read it. Personal completion never claims team agreement.
10. `safe → unsafe`, `paid → unpaid`, changed amounts, and changed obligations invalidate affected endorsement. Agreement remains tied to the wording actually reviewed.
11. Reload and switch between review and document: intentional folds and location restore sensibly. Existing histories, imports, exports, and AI operations still work.
12. All primary actions are reachable without hover. Keyboard focus is visible and preserved; expanded controls expose their state; statuses have text, not color alone.

Use focused behavior tests plus real local browser flows. Update tests that intentionally encode superseded interactions; retain protections for text integrity, permissions, attribution, undo, and concurrent editing. Follow the current repo build/test instructions, compare type errors against baseline, and report exactly what ran. Do not claim success from screenshots alone.

## Handoff deliverables

Provide the implementation branch and commits; a concise before/after explanation; updated guidance that distinguishes revised proposals from historical rulings; desktop and phone evidence; and a validation report naming any unresolved defects or compatibility risks. Keep `AGENTS.md` and `CLAUDE.md` synchronized if changed.

Use a local review fixture for the final walkthrough: read, agree with a passage, suggest a replacement, inspect an objection, return to an earlier section, and find what still needs attention. A new reader should be able to predict each action's effect without knowing timers, hover rules, or hidden acceptance state.

Leave integration and deployment to the designated reviewer under the project's current workflow. Do not modify production data or send invitations or other messages as part of verification.
