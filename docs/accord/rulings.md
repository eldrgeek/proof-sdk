# Accord — Mike's rulings, in date order

Each line is a ruling Mike made, with its date and where it is recorded. A ruling is not reopened by an AI; if you think one is wrong, say so in your report with the reason and leave the behaviour as ruled. Rulings on the predecessor standard (MDP) that Accord inherits are in `~/Projects/SOMA/shared-cognition/mdp-agreed-model.md`; the ones that still bind are repeated here.

## Inherited from MDP (2026-09-01 to 09-12)

- **Assent is bracketed, not silent** (2026-09-03). An explicit mark on line A and an explicit mark on a later line B imply at least "seen" on every line between them, revisions included. Lines after the reader's last mark are unread, not agreed.
- **A ruling is never inferred from an agree mark** (protocol R4). A decision has its own control.
- **The ringer list** (2026-09-12, Q4 ratified): a round closes with a few writer-planted or writer-flagged sentences the reader should not have agreed with, placed where attention can reach them. Changes the reader scrolled past show as change marks in the text, not as a list.
- **Answer format** (2026-09-12): "1. Conclusion or recommendation. 2. Reason (if needed) 3. Yes/No etc." Clicking No starts an inline edit "No, because " with the cursor after "because".
- **Never ship a ratification surface as a bare `.md` file** (2026-09-03): "Markdown document is not MDP and so I cannot respond there." Define every term the page uses.
- **The Waiting on Mike page renders no change marks and no ringer list** (2026-09-12): "I don't need to know how you changed it, only that it is waiting." Jointly edited documents keep the marks.

## The spec (2026-09-18 to 09-19)

- 2026-09-18: Mike's text in the Google Doc "Proof and MDP" is the base of the spec; Claude's changes are suggestions he accepts from the page, never applied for him. Source: the spec page, first line.
- 2026-09-19, morning: **Yes to all nine asks** (Issue = unseen by someone or rejected; aligned = no objection, agreed is stronger; Agreed personal, Approved Owner-binding; scroll-accepts provisional; proxy marks next; decision lines vs context lines; `[text]{type @source}` plus CriticMarkup; pick our own name and use it in SOMA; delete the "importance" line). Source: `docs/accord/spec-hgff4jxe-2026-09-23.md`, the asks table.
- 2026-09-19: **"Accord it is, use it everywhere."** The standard, the editor, each document ("an Accord") and the SOMA vocabulary are Accord. The upstream open-source project keeps its name, Proof SDK. User-facing strings only: no API path, header, field, event, error code, table, slug, token, CSS class or test selector changed (`src/shared/product-identity.ts`). Source: ESTATE.md 2026-09-19.
- 2026-09-19, in chat: he hates the engine's built-in review pop-ups. **Clicking marked text must just edit, Docs-like.** The view must not jump while he types. Scroll is acceptance and agreement, provisional until the next deliberate action. Editing another person's line is treated differently when it changes meaning than when it does not.
- 2026-09-19: an ask's questions live in the document; do not echo them in chat.
- 2026-09-19: when a person closes an Issue it folds for that person. Hovering a line puts its decision mark in the margin; touch surfaces need another way to show the current item. Undo for every user change. "?" after a sentence means clarify. A group with no Issues closes; hover opens it. An explicit unfold is never refolded.

## The layout (2026-09-21)

- **Yes to Ren's twelve decisions**: "build the layout that you proposed." Source: `docs/accord/layout-6ybuxh8e-2026-09-23.md`, its ruled line.
- **"Yes to both"**: resting the mouse on another line ends Writing mode once typing has paused; Option+click (Alt) edits a link's words, a plain click opens the link. Source: the spec page, "Ruled (Mike, 21 September)".
- His usability findings from the Waiting on Mike Accord (2026-09-21) are in the spec text under "Using the Waiting on Mike Accord" and were fixed in 3474b69: links open on click, A never types into the text, "Save N accepted changes" works, rail and chat scroll independently, tighter top bar.

## Round 2 (2026-09-22)

- **"Great ideas. Go and build."** Four stages, all live: the scroll camera (14fc19b), threads in the document (5dc539a), the Open/Accord views (7d4c732), the edit gesture (27bd48e). Source: ESTATE.md 2026-09-22.
- A thread and a proposal are one object; deleting the anchored text detaches the thread with a notice instead of deleting the disagreement; existing comments and suggestions are read as threads with no migration.
- One definition of Open (`src/shared/open-view.ts`) feeds the Issues pill, the amber dots and the Open list, and a test says they cannot disagree. Agreement lapses on a substantive edit and survives a cosmetic one.

## Standing gates and open questions (as of 2026-09-23)

- **Direct Editing mode's conversion to proposals is gated OFF** (`EDIT_SESSION_POLICY.convertDirectEditsToProposals`). Reason, measured: a second local write to a line a remote writer is touching makes y-prosemirror resync the whole document, and the resync concatenates it; four other causes were tested and ruled out. Gate to open it: `scripts/caret-stability-check.mjs` green five consecutive runs. The fix is on branch `accord/yjs-resync` (b8a7c97), unmerged. Source: commit 27bd48e.
- **Open for Mike:** unread lines are not Open (`OPEN_VIEW_POLICY.unreadLinesAreOpen = false`). One line flips it; the invariant is tested both ways.
- **Not built, and not to be started without Mike's word:** the room scribe (a standing AI member that drafts the page from the floor), a conversation-first landing, promotion of a floor message onto the page. Mike's two rulings that frame them (2026-09-19): the conversation surface is per document, and Accord is "a chat tool that leaves documents behind", not a documentation tool with chat.
- Invitations send through Resend from `accord@mike-wolf.com` since 2026-09-23 (7b5c574); the key lives only on the VPS.
