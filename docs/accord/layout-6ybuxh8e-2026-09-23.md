# Accord — the layout proposal (snapshot of the live document `6ybuxh8e`)

Exported 2026-09-23 18:17 EDT from https://proof.vpsmikewolf.duckdns.org/d/6ybuxh8e, revision 14: 55 lines, 12 decisions. **The live document is canonical.** Ren (SOMA's UI designer) wrote it on 2026-09-21 at Mike's request; Mike ruled the same day, in chat, "build the layout that you proposed", Yes to all twelve decisions. It was built in three stages (b3545eb, 504e040, 9430837) plus polish (5bceb7b), all live. Read it to learn why the page looks the way it does: three regions with one job each (Navigator, Page, Margin), a menu bar and one toolbar row, a fixed status bar, one cursor, two highlight states, and the phone strip. The desktop and phone mockups it refers to were sent in chat and are not in this repo.

## The text, as exported

*Designed by Ren (SOMA's UI designer, running on Anthropic Fable) at Mike's request of 21 September. The desktop and phone mockups are sent alongside in chat. Answer each decision below with Yes, Not yet or No (keys Y, T, N).*


**Ruled (Mike, 21 September, in chat): "build the layout that you proposed" — Yes to all twelve decisions below. Building in three stages: 1 status bar, marked-up-to line, two highlights, visible mode; 2 menu bar and toolbar, Share absorbs Invite and Add agent, settings into menus; 3 Line and Room tabs, Navigator, one cursor, phone strip.**


# Accord layout proposal (Ren, 21 September)


*Ren (SOMA UI), 2026-09-21, for Mike Wolf. Proposal only; nothing in the product changed.*


## Why it feels complicated


1. **The right rail does four jobs.** It navigates (reading position, outline, since-you), it acts on one line (mark, changes, asks), it holds settings (reading speed, sitting budget, undo), and it is the room chat. Chat sits at the bottom of a scrolling rail, so the reading position scrolls out of view. That is Mike's complaint, and it is a layout bug.
2. **Three highlights mean "here".** Hover band, reading-focus band and focus line all say "this line" in slightly different senses. A reader cannot tell which of the three the A/R keys will act on. With provisional-dashed, context-dim, decision ◆ and fold chips, the page carries seven states at once.
3. **Modes are invisible.** Suggesting/Editing is a small label in the pill. Reading versus writing (do A and R mark, or type letters?) is never shown at all.
4. **The top pill is a toolbar pretending to be a status bar.** Eight ungrouped items: identity, save state, mode, Issues count, navigation, two people actions, Share.
5. **"What is left for me" is shown four ways.** Issues count, since-you list, margin dots, inline ask boxes. Four views of one question.
6. **The documents list costs 220 px all day** for a choice made once per session.


## The recommended layout


Three regions, each with one job you can name: **Navigator** (where things are), **Page** (read and write), **Margin** (talk about this line, or about the room). Chrome is a menu bar and one toolbar row above, and one status bar below the page.


### Menu bar and toolbar (no ribbon)


* **Menu bar (28 px): File · Edit · View · People · Help.** Docs and Word taught this order, so it needs no explaining.
  * File: New, Open (the documents list lives here now), Rename, Copy link, Export Markdown.
  * Edit: Undo, Redo, Find, Suggesting / Editing (radio).
  * View: Navigator, Margin, Fold to headings, Reading settings (speed, sitting budget), Keyboard shortcuts.
  * People: Share, Invite person, Add agent, Who is here.
  * Help: Keyboard shortcuts, Agent docs, About.
* **No ribbon.** Ribbons carry formatting verbs, and Accord has five verbs (Agree, Reject, Accept, Reply, Answer) that already fit on one row.
* **Toolbar (44 px), one row, three groups.** Left: the Suggesting | Editing segmented switch and Undo. Centre: title and "Saved". Right: the **Issues pill** ("12 Issues · Next") and one **Share** button. Invite person and Add agent become tabs inside the Share dialog, which is the Docs convention.


### Status bar under the page (the answer to "where does it live")


* A **fixed 28 px status bar** at the bottom of the page column holds **"Line 41 of 118"**, **"You marked up to line 37 · 2 min ago"** (click to jump), and the state word **Reading** or **Writing**. Word puts page position here, and a fixed bar cannot scroll away.
* A **"You marked up to here" rule** also sits in the page itself after the last marked line, like Slack's new-messages line. Everything above the rule is settled.


### One cursor


* Reading-focus and focus line merge into **one cursor**. Scrolling moves it (scrolling reads); clicking sets it (explicit beats automatic). Keys and the Margin act on this one line, and the status bar names it.
* Reading versus writing is **shown, not switched**. Caret in text = Writing, keys are letters; caret out = Reading, keys are marks. Suggesting versus Editing stays the only switch a person chooses, because "click text = type" must keep working.


### Two highlight states, plain meanings


* **Blue bar and tint = "you are here."** One line only.
* **Amber margin marker = "needs you."** Lines with an open ask or an unanswered change. The Issues count is the number of amber markers, so the two always agree.
* Removed: hover band (hover shows a small margin preview only, the text never changes), context dimming (it moves weight under the reader), provisional-dashed (an accepted change becomes plain text with an Undo toast), decision ◆ band (a decided ask shows a grey check in the margin). Pending edits render as Docs-style insert/delete text, which is content, not a highlight.


### The Margin: two tabs


* **Line 41** tab: the thread on this line. Quote, then Agree / Reject as the two primary buttons, then that line's changes (Accept / Reject / Reply), asks (Yes / Not yet / No), the Familiar's brief folded under "Familiar says", and a reply box. One thread per line is the Wave idea; Resolve closes it.
* **Room** tab: the floor chat, with an unread badge. It is full height, so it pushes nothing off screen.
* The tab label carries the line number, so a person on the Room tab still knows what A and R will hit. The tab does not switch itself.


### The Navigator: three tabs, left side


* **Outline · Issues · Since you.** These are lists of the whole document, so they belong opposite the per-line Margin. Fold controls live on the Outline, as in Docs. It closes by default under 1100 px.


### Phone


* One column: a 44 px top bar (title, Issues count, ⋯ menu), the page, and a 56 px bottom strip with **Line 41 of 118**, **Agree**, **Reject**, **More**. Swipe up on the strip opens a sheet with the same **Line · Room** tabs. The ⋯ menu holds Share, Suggesting/Editing, Navigator and Reading settings. The page is never covered by more than the sheet.


### Removed or hidden


* Reading speed and sitting budget go to View › Reading settings. Undo goes to Edit and Ctrl/Cmd-Z. The documents column goes to File › Open. Proxy brief folds. The keyboard list goes to Help. Seen becomes implicit (scrolling reads) and Approve goes under More, because a person marks Agree or Reject far more often than the other two.


## Decisions


Add a menu bar (File, Edit, View, People, Help) and no ribbon?


Move the reading position and "last marked" into a fixed status bar under the page?


Add a "You marked up to here" line inside the page?


Merge the reading focus and the focus line into one cursor that scrolling moves and a click sets?


Cut highlights to two: a blue bar for "you are here" and an amber dot for "needs you"?


Make the right side two tabs, Line and Room, and nothing else?


Make the left side a Navigator (Outline, Issues, Since you), and move the documents list to File > Open?


Make Agree and Reject the two main buttons, with Seen implicit and Approve under More?


Show reading versus writing as a state (the caret in the text means writing) and keep Suggesting/Editing as the only switch?


Move reading speed, the sitting budget and the proxy brief out of the main view into menus and a fold?


On a phone, use a bottom strip (position, Agree, Reject, More) and a Line/Room sheet?


Fold Invite person and Add agent into the Share dialog?

