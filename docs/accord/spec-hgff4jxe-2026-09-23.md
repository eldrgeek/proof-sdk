# Accord — the spec (snapshot of the live document `hgff4jxe`)

Exported 2026-09-23 18:17 EDT from https://proof.vpsmikewolf.duckdns.org/d/hgff4jxe, revision 89: 81 lines, 98 Issues open, 9 asks. **The live document is canonical.** This file exists so that an AI without network access (Codex under its sandbox, for example) can read the spec. Nothing here is newer than the live page; if the two differ, the page wins.

The text is Mike Wolf's, from his Google Doc "Proof and MDP" (18 September 2026), carried over unchanged, plus his later words placed by Claude with dates, and Claude's proposed build plan. In the live page Claude's proposed changes are suggestions Mike accepts or rejects, and Claude's questions are asks. Lines nobody has agreed yet are Issues there; that is the normal state of a spec under discussion, not a sign of dispute.

## The nine asks, and Mike's answers (2026-09-19, through the Yes / Not yet / No buttons)

| # | Ask | Answer |
|---|---|---|
| 1 | Should an Issue be any line or mark that some team member has not seen, or that some team member has rejected? | Yes |
| 2 | Should "aligned" mean everyone has seen every line and nobody has rejected one, with "agreed" as the stronger state where everyone agreed? | Yes |
| 3 | Should Agreed be one member's personal agreement, and Approved an Owner's binding ruling? | Yes |
| 4 | Should an accept made by scrolling stay provisional until your next deliberate action (a key, a click or an answer)? | Yes |
| 5 | Should the next big build be Familiar proxy marks: your Familiar AI pre-marks the lines it is sure you would accept, and you ratify them with one click? | Yes |
| 6 | Should each line be either a decision line (it needs your mark) or a context line (your Familiar's read is enough)? | Yes |
| 7 | Should the mark form stay `[text]{type @source key=value}`, with CriticMarkup import and export? | Yes |
| 8 | Should we keep the name "Accords" inside SOMA, and pick a name of our own before publishing it as a standard? | Yes: "Once we pick the name, we should use that name within SOMA as well." Then, the same day: "Accord it is, use it everywhere." (The ask is still open on the page only because the name question was answered in chat.) |
| 9 | Is the "text about importance" you asked me to remove your first line, "One of the highest value things we can do…"? | Yes ("I think you're talking about the first line in the response card. And I will confirm yes.") |

## The text, as exported

*Mike Wolf's text from the Google Doc "Proof and MDP" (18 September 2026), carried over unchanged. Claude's proposed changes are suggestions you can accept or reject. Claude's questions are comments. Mark any line; reply to any comment.*


## Questions for you (answer Yes, Not yet or No; press Y, T or N)


Should an Issue be any line or mark that some team member has not seen, or that some team member has rejected?


Should "aligned" mean everyone has seen every line and nobody has rejected one, with "agreed" as the stronger state where everyone agreed?


Should Agreed be one member's personal agreement, and Approved an Owner's binding ruling?


Should an accept made by scrolling stay provisional until your next deliberate action (a key, a click or an answer)?


Should the next big build be Familiar proxy marks: your Familiar AI pre-marks the lines it is sure you would accept, and you ratify them with one click?


Should each line be either a decision line (it needs your mark) or a context line (your Familiar's read is enough)?


Should the mark form stay \[text]{type @source key=value}, with CriticMarkup import and export?


Should we keep the name "Accords" inside SOMA, and pick a name of our own before publishing it as a standard?


Is the "text about importance" you asked me to remove your first line, "One of the highest value things we can do…"?


This will become a SOMA standard replacing MDP/MAP or whatever we call it.


A Proof Document and the Proof Editor take adding ideas from document editors like Google Docs, from Pulse Zero, Pulse, Marked Document Protocol.


An Accord is a document written in a markdown dialect for use in the Accord Editor, which is built on the open-source Proof SDK.


The Accord Editor renders an Accord for humans and can be used by AIs.


In the dialect an Accord Mark in the document takes this form \[...]{mark}, derived from the Markdown \[...]\(target) syntax


Edited text ~~deleted~~ inserted is marked this away: \[~~deleted~~ inserted]{changed @mw}


A Mark gives its type e.g. ‘changed’ and thae source of the mark e.g @mw. Marks can have other types


The braces hold the mark's type first, then its source, then optional fields written key=value, separated by spaces. Example: \[This sentence]{agreed @mw at=2026-09-18}. A pure insertion is \[new words]{changed @mw}. A pure deletion is \[~~old words~~]{changed @mw}.


A Accord Team (PT) is a team of AIs and Humans working on a particular Accord.


A Team Member (TM) is one of the members of a PT.


A PT has two or more members. The membership can be any number of AIs or humans.


The usual case is one human and one AI. For a collaboration (e.g. Eric and Mike) the collaboration might be two humans and two AIs


Throughout SOMA each user has one or more Familiar AI’s. A Familiar AI is an AI that has access to enough information to be a trusted advisor to that human.


A Accord typically has a hierarchical outline and can be folded and unfolded in the Accord Editor


A Accord has hyperlinks to internal bookmarks or external documents.


Interactions in an Accord are designed to minimize the human effort to achieve alignment.


A TM creates an Accord and invites others to be TMs.


A PD has an Owner.


The TM who creates the Accord is its Owner.


Ownership can be shared or delegated.


A document owner can invite others to be TMs and they are automatically approved


A TM can propose others to be TMs and they are approved by either an Owner or 50% or the TMs.


If there is any object in a document that not every TM has read, then that object is an Issue.


If there is an object that has been rejected, then that object is an issue


An Issue is any line or mark in an Accord that some TM has not seen, or that some TM has rejected. If there are no issues in a document then the PT and document are aligned.


When a line changes, every TM's mark on that line returns to unseen, except the mark of the TM who made the change. So every change is an Issue until every TM has seen it.


The contents of a proof document are marked at the line level (row level for tables). Marks are: unseen (the default, no mark) Seen. Agreed. Approved. Rejected. Changed.


Seen means "I have read this line." Agreed means "I agree with this line." Approved means "this line is binding"; only an Owner can approve. Rejected means "I do not accept this line"; a rejection carries a reason. Changed means the line has an edit that some TM has not yet seen.


Each TM's line marks are stored with the document, not written into the line's text, so the text stays readable. Exporting an Accord can write them into the text as \[...]{mark} marks.


Assent is bracketed: when a human TM marks two lines, every line between them that the TM did not mark counts as at least Seen. Lines after that TM's last mark stay unseen.


An AI TM marks a line Seen when it reads the revision that contains the line. An AI's Agreed, Approved or Rejected mark is always explicit.


A folded section carries one or two marks: one indicates "issues remain" the other "issues resolved" If a document has unseen content, issues remain.


A folded section shows how many Issues it contains, or a check mark when it contains none. Marking a folded section's heading applies that mark to every line inside the section.


Here is how I would frame it. A Accord has a chat sidebar. The sidebar can be closed or open. It must be usable on mobile. The chat sidebar i


## Reading and marking (Mike, 18 September, in chat — his words, placed here by Claude)


When a doc is rendered it takes the full width. Instead, like Docs it should take the middle and leave room on the right for a chat panel and on the left for a list of docs.


There is something that highlights the first line and puts the "Mark this line" box in the right hand side chat area.


Typing A agrees, R rejects, and scrolling down indicates it has been read.


When a line has changes (marks that have not been accepted) the dialog also appears in the right side rail.


If a line has 10 marks, scrolling down stays on the line and scrolls down one after the other.


Scrolling past a change accepts it. But scrolling back up removes anything that was accepted by scrolling but not by user action.


Marks like hyperlinks take action, but there are other actions, too. They incorporate the ideas in Pulse Zero.


When there is a statement in a document proposed by another I can signify my agreement explicitly or acceptance (and agreement) implicitly by scroll behavior. Or I can modify the statement. If the statement is not meaning changing it is treated differently than if it is meaningful. (Mike, 19 September)


Once we pick the name, we should use that name within SOMA as well. (Mike, 19 September, answering the naming question)


Accord it is, use it everywhere. (Mike, 19 September — the standard, the editor, the documents and the SOMA vocabulary are all Accord from here. The upstream open-source project we build on keeps its own name, Proof SDK.)


When an issue is closed by a user, it should be folded for that user. I'm not sure what the decision should be on folding other open issues. (Mike, 19 September)


Hovering over a line puts its decision mark in the chat; having to click is extra work. On a touch surface, there should be some other way to indicate what the current mark or the current item being looked at is. (Mike, 19 September)


What is the better name for what we have? It is not just a doc editor. It could be a chat. It could have threads, and then resolve the threads. It has characteristics of Google Wave. (Mike, 19 September)


Undo is needed for every user change.


Once I have accepted something, reject does not seem to work. Typing ? after a sentence means clarify.


Leaving a group with no issues closes the group. Hovering over a closed group opens it.


If the user moves the mouse on desktop, the selected element becomes highlighted and is the focus.


When a folded item below an H level is unfolded, it does not refold.


Using the Waiting on Mike Accord (Mike, 21 September):


Clicking a link should take you to the link, not through the Open Link device.


Typing A to accept sometimes inserts an A in the text.


Scrolling through a line that has had an edit pops "1 change accepted by scrolling, not saved yet. Scroll back to undo." with a button "Commit 1 accepted". Clicking the button does nothing.


The marks in the sidebar do not automatically scroll down to the bottom.


Scrolling in the chat sidebar and scrolling in the text are not decoupled. Scrolling in the text should always scroll the chat to the bottom, where the mark for the text is found.


The reading panel is attached to the chat and can scroll out of view. It should be somewhere else. Likewise the indicator of when last marked.


The bar at the top (Accord, name of document and so on) has excess whitespace above and below the buttons.


Maybe there should be a menu bar and a ribbon like Word and Docs. The goal is to simplify interaction, and it is still too complicated. The highlighting works, but from a user perspective it is confusing.


Ruled (Mike, 21 September, "Yes to both"): resting the mouse on another line ends Writing mode once typing has paused; Option+click (Alt) edits a link's words, and a plain click opens the link.


## Build plan for the Accord Editor (proposed by Claude)


Step 1: line marks. Each line gets a small control in the margin with Seen, Agreed, Approved, Rejected. The top bar shows the number of Issues and a Next Issue button. An edit resets the line's marks, as described above.


Step 2: folding. Headings fold and unfold. A folded section shows its Issue count, and marking its heading marks every line inside it.


Step 3: the \[...]{mark} dialect. Exporting writes marks into the text in this form; importing reads them back.


Step 4: the team. The Owner, invitations, proposals and votes, and each human's Familiar AI.


Step 5: the chat sidebar, once the paragraph above is finished.


I am starting Step 1 now on a branch, because every open question above leaves it unchanged. Nothing goes live until it passes Proof's browser checks.

