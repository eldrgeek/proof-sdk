# Estate organization: where we are, and the plan

*For Mike Wolf. Written 2026-09-23 by Claude Fable 5.1 (Claude Code, session a5874f2d) after a review of fleet-views, yeshid-control-plane, the seat and persona registries, the open asks, the Desktop session list, and today's hygiene and verification sweeps. Every decision below carries a recommendation and Yes / Not yet / No buttons. Mark any claim you dispute where it stands.*

## Where we are

1. The board project (fleet-views, the Call Board, the `estate` command) was built in one burst from 12 to 17 September.
2. Nothing in it has changed since 17 September. Every commit after that date is an automatic data refresh.
3. It stopped because no seat, bead or standing steward owned it once the session that built it ended.
4. The board is live and refreshing. The Mac pushes every minute and the data refresh runs every two hours, and both were healthy today.
5. No sign-in by you is on record. I cannot tell whether you have seen the board since it moved to fleet.mike-wolf.com on 16 September.
6. The AIs' command `estate` was answering from data six days old, because the refresh wrote to a different checkout than the one the command reads. Fixed today.
7. `estate doing` reported two claims from 11 August as live work, because it ignored the lease rules that `work-claim` applies. Fixed today.
8. The Roster view has not been regenerated since 17 September. Its seed is a hand-run script, not part of the refresh.
9. Your attention is split across five queues: Waiting on Mike in Accord (29 open), Pulse Zero, the July work queue (45 groups needing you), the board's Needs-Mike cards, and asks made in chat.
10. The hierarchy you named, AI family → named seat → project, exists as three lists that do not join: 13 seats, 19 personas and the agent registry.
11. 139 of 201 repos belong to no project, and 25 of those are active. "Project" cannot organize the estate yet.
12. 200 sessions are unarchived in the Desktop app. 47 have a merged pull request, 5 are forks, and 76 have not been touched in a month.
13. Nothing records whether a conversation finished, finished somewhere else, or was dropped. Your ask today has no data behind it yet.
14. The guidance files every AI reads have drifted: 53 changed and 205 new against the 13 August baseline, and 27 verification findings are open.
15. The COO loop and the twice-daily briefing have been stood down since 11 September by your order, until the deliverables were out.

## What organized means here

16. You open one page each morning and see what finished, what is waiting on you, and what we propose to abandon.
17. Every piece of work has one owner seat and one project, and a machine keeps its status current.
18. An AI starting work asks one command and gets a fresh answer: who am I, is this already being done, what is currently true.
19. Nothing is abandoned by neglect. Every initiative is kept, parked with a wake condition, or abandoned on the record with a reason.
20. People other than you see their slice through a lens, under limits you have set.

## The plan in one paragraph

21. Give the work an owner, join the three roster lists into the spine you named, run a nightly conversation review that feeds one morning page, and collapse your five queues into one. The decisions below are those moves, one each. The fixes that needed no ruling are already done and listed under "Just so you know".

## Decisions for you

Each item is one decision. The recommendation comes first, then the reason. Answer with the buttons on the title line.

## Needs your hands

Only what needs your fingertip.

## Just so you know

Done today, no action needed.

## Done since last revision

### The estate command now reads today's data

Ruled 2026-09-24 (Yes button)

Ask key: estate-cli-fresh · resolved 2026-09-24

### Give the estate organization an owner seat

Ruled 2026-09-24 (Yes button)

Ask key: estate-owner-seat · resolved 2026-09-24

### One roster with the spine you named: AI family, runtime, named seat, live performance, project

Ruled 2026-09-24 (Yes button)

Ask key: roster-spine · resolved 2026-09-24

### A nightly conversation review that feeds one morning page

Ruled 2026-09-24 (Yes button)

Ask key: conversation-review · resolved 2026-09-24

### One queue for you: Waiting on Mike in Accord

Ruled 2026-09-24 (Yes button)

Ask key: one-queue · resolved 2026-09-24

### Every active repo gets a project, and dormant repos are proposed for archive

Ruled 2026-09-24 (Yes button)

Ask key: every-repo-a-home · resolved 2026-09-24

### Beads pilot: graduate it (the decision was due 22 September)

Ruled 2026-09-24 (Yes button)

Ask key: beads-graduate · resolved 2026-09-24

### Keep the COO loop and the briefing stood down; the review takes the briefing's job

Ruled 2026-09-24 (Yes button)

Ask key: coo-stays-down · resolved 2026-09-24

### Adopt the board's limits as the brain trust proposed them

Ruled 2026-09-24 (Yes button)

Ask key: board-limits · resolved 2026-09-24

### Sign in to the board once and tell me what is wrong with the first screen

Ruled 2026-09-24 (Yes button): “The board looks good. I started walking through the issues The first went to the Resources which showed some keys that needeed work, but there were no links to help me complete”

Ask key: board-first-sign-in · resolved 2026-09-24

### estate doing now agrees with work-claim

Ruled 2026-09-24 (Yes button)

Ask key: estate-doing-liveness · resolved 2026-09-24

### Beads pilot scorecard: 71 of 73 gated pull requests carried a bead

Ruled 2026-09-24 (Yes button)

Ask key: beads-scorecard · resolved 2026-09-24

## Terms

* **Accord**: the SOMA standard and editor for a document a team reads, marks line by line and answers until it has no Issues left. This page is an Accord.
* **AI family**: the vendor a runtime belongs to: Anthropic, OpenAI, Google, xAI, Cursor.
* **Runtime**: the program an AI runs in, for example Claude Code, Codex CLI or Cursor.
* **Seat**: a standing role with declared authority (`_estate/seats.json`). A seat does not expire; its leases do.
* **Persona**: a named role with a role file, for example Dee, Ren, Locke. The plan treats a persona as a kind of seat.
* **Performance**: one live session or run of a seat. One seat can have several performances at once.
* **Project**: a named body of work with a declared home repo and importance (`fleet-views/data-src/projects.manifest.json`).
* **Initiative**: a thread of work that may span several conversations and projects. The conversation review names them.
* **Conversation review**: the nightly pass that classifies every conversation as completed here, completed elsewhere, open, or dropped, and proposes keep, park or abandon per initiative.
* **Bead**: one task with an id, owner, status and dependencies, claimed atomically (`_estate/bin/bead`).
* **Lens**: the server-side filter that decides what a viewer sees on the board: operator, family or partner.
* **Waiting on Mike**: the one Accord that holds every ask to you, driven by `_estate/bin/ask-mike`.
