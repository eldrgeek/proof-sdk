# Proof Agent Docs

## Proof SDK Route Alias

Hosted Proof keeps the `/api/agent/*` and `/share/markdown` compatibility routes.

The reusable `Proof SDK` surface is mounted in parallel at:

- `POST /documents`
- `GET /documents/:slug/state`
- `GET /documents/:slug/snapshot`
- `POST /documents/:slug/ops`
- `POST /documents/:slug/presence`
- `GET /documents/:slug/events/pending`
- `POST /documents/:slug/events/ack`
- `GET /documents/:slug/bridge/state`
- `GET /documents/:slug/bridge/marks`
- `POST /documents/:slug/bridge/comments`
- `POST /documents/:slug/bridge/suggestions`
- `POST /documents/:slug/bridge/rewrite`
- `POST /documents/:slug/bridge/presence`

## Which Editing Method Should I Use?

Proof has three editing approaches. **Pick one — don't mix them.**

| Goal | Method | Endpoint |
|------|--------|----------|
| **Add/replace/insert a few lines** (recommended) | Edit V2 (block-level) | `GET /snapshot` → `POST /edit/v2` |
| **Simple text replacement** | Structured edit | `POST /edit` |
| **Replace entire document** | Rewrite | `POST /ops` with `rewrite.apply` |
| **Add a comment** | Ops | `POST /ops` with `comment.add` |

**Start with Edit V2** for most tasks. It uses stable block refs, handles concurrent edits cleanly, and returns clean markdown without internal HTML annotations.

`suggestion.add` now matches against annotated documents correctly and preserves stable anchors, but `edit/v2` is still the better default for programmatic content changes.

`rewrite.apply` is still disruptive. Avoid it if anyone might have the document open: hosted environments block rewrites while live authenticated collaborators are connected, and `force` is ignored there.

## I Just Received A Proof Link

No browser automation is required. Use HTTP directly (for example, `curl` or your tool's `web_fetch`).

If you received a shared link like:

  http://localhost:4000/d/<slug>?token=<token>

You can discover the API and read the document in one step using **content negotiation** on that same URL.

Fetch JSON (recommended):

  curl -H "Accept: application/json" "http://localhost:4000/d/<slug>?token=<token>"

Fetch raw markdown:

  curl -H "Accept: text/markdown" "http://localhost:4000/d/<slug>?token=<token>"

The JSON response includes:
- `markdown` (document content)
- `_links` (state, ops, docs)
- `agent.auth` hints (how to use the token)

### Quick copy/paste flow (token already in the shared URL)

```bash
SHARE_URL='http://localhost:4000/d/<slug>?token=<token>'
TOKEN='<token>'
SLUG='<slug>'

curl -H "Accept: application/json" "$SHARE_URL"
curl -H "Accept: text/markdown" "$SHARE_URL"
curl -H "Authorization: Bearer $TOKEN" -H "X-Agent-Id: your-agent" "http://localhost:4000/documents/$SLUG/state"
```

## Auth: Token From URL

If a URL contains `?token=`, treat it as an access token:

- Preferred: `Authorization: Bearer <token>`
- Also accepted: `x-share-token: <token>`

## Edit Via Ops (Comments, Suggestions, Rewrite)

Use:

  POST /documents/<slug>/ops

`by` controls authorship. Presence is explicit-only: send `X-Agent-Id: <your-agent-id>` (or `agentId` in the JSON body) when you want the agent to appear in presence.

Add a comment:

  curl -X POST "http://localhost:4000/documents/<slug>/ops?token=<token>" \
    -H "Content-Type: application/json" \
    -H "X-Agent-Id: your-agent" \
    -d '{"type":"comment.add","by":"ai:your-agent","quote":"text to anchor","text":"comment body"}'

Suggest a replace:

  curl -X POST "http://localhost:4000/documents/<slug>/ops?token=<token>" \
    -H "Content-Type: application/json" \
    -H "X-Agent-Id: your-agent" \
    -d '{"type":"suggestion.add","by":"ai:your-agent","kind":"replace","quote":"old text","content":"new text"}'

Create and immediately apply a suggestion:

  curl -X POST "http://localhost:4000/documents/<slug>/ops?token=<token>" \
    -H "Content-Type: application/json" \
    -H "X-Agent-Id: your-agent" \
    -d '{"type":"suggestion.add","by":"ai:your-agent","kind":"replace","quote":"old text","content":"new text","status":"accepted"}'

Rewrite the whole document:

  curl -X POST "http://localhost:4000/documents/<slug>/ops?token=<token>" \
    -H "Content-Type: application/json" \
    -H "X-Agent-Id: your-agent" \
    -d '{"type":"rewrite.apply","by":"ai:your-agent","content":"# New markdown..."}'

## Edit Via Structured Operations (Append, Replace, Insert)

For surgical edits without rewriting the entire document, use the `/edit` endpoint:

  POST /documents/<slug>/edit

All requests require `Content-Type: application/json` and auth via `Authorization: Bearer <token>`.

The body must include an `operations` array (max 50 ops) and a `by` field for authorship. If you want presence, also send `X-Agent-Id: <your-agent-id>` or `agentId` in the body.

### Append to a section

Add content at the end of a named section (matched by heading text):

  curl -X POST "http://localhost:4000/documents/<slug>/edit" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer <token>" \
    -H "X-Agent-Id: your-agent" \
    -d '{
      "by": "ai:your-agent",
      "operations": [
        {"op": "append", "section": "Brandon", "content": "\n\n**Feb 16, 2026**\n\nNew brainstorm idea here."}
      ]
    }'

The `section` value is matched against heading text (e.g., `"Brandon"` matches `### Brandon`).

### Replace text

Find and replace a specific string in the document:

  curl -X POST "http://localhost:4000/documents/<slug>/edit" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer <token>" \
    -H "X-Agent-Id: your-agent" \
    -d '{
      "by": "ai:your-agent",
      "operations": [
        {"op": "replace", "search": "old text to find", "content": "new replacement text"}
      ]
    }'

### Insert after text

Insert content after a specific anchor string:

  curl -X POST "http://localhost:4000/documents/<slug>/edit" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer <token>" \
    -H "X-Agent-Id: your-agent" \
    -d '{
      "by": "ai:your-agent",
      "operations": [
        {"op": "insert", "after": "anchor text to find", "content": "\n\nContent to insert after the anchor."}
      ]
    }'

`insert` only supports `after`. Payloads using `before` are rejected with `INVALID_OPERATIONS`.

### Multiple operations

You can combine operations in a single request (applied in order):

  curl -X POST "http://localhost:4000/documents/<slug>/edit" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer <token>" \
    -H "X-Agent-Id: your-agent" \
    -d '{
      "by": "ai:your-agent",
      "operations": [
        {"op": "append", "section": "Dan", "content": "\n\nNew idea from Dan."},
        {"op": "replace", "search": "(placeholder)", "content": "Actual content here."}
      ]
    }'

### Response

A successful response includes:

  {
    "success": true,
    "slug": "<slug>",
    "updatedAt": "<ISO timestamp>",
    "collabApplied": true
  }

- `collabApplied: true` means the edit was pushed into the live collab session (connected viewers see it in real time).
- `presenceApplied` is only `true` when you also supplied explicit agent identity via `X-Agent-Id`, `agentId`, or `agent.id`.
- If the document changed since you last read it, you may get a `409 STALE_BASE` error — re-fetch state and retry.

Collab convergence fields:
- `collab.status` is render-authoritative (`confirmed` when the ProseMirror/Yjs fragment converged).
- `collab.fragmentStatus` tracks fragment convergence (`confirmed|pending`).
- `collab.markdownStatus` tracks SQL markdown projection convergence (`confirmed|pending`).
- `collabApplied` follows `fragmentStatus` (not markdown projection status).

### Optimistic locking (required for `/edit`)

Pass `baseUpdatedAt` (from a prior state response) to detect concurrent edits:

  {"by": "ai:your-agent", "baseUpdatedAt": "2026-02-16T...", "operations": [...]}

If the document's `updatedAt` doesn't match, you'll get a `409` with `retryWithState` pointing to the state endpoint.

## Update Title Metadata

Use:

  PUT /documents/<slug>/title

Example:

  curl -X PUT "http://localhost:4000/documents/<slug>/title" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer <token>" \
    -d '{"title":"Updated document title"}'

Discovery:
- `GET /documents/<slug>/state` includes `_links.title` and `agent.titleApi`.

## Edit V2 (Block IDs + Revision Locking)

Use v2 for top-level block edits with stable block IDs and revision-based optimistic locking.

### Get a snapshot

  GET /documents/<slug>/snapshot

Example:

  curl -H "Authorization: Bearer <token>" "http://localhost:4000/documents/<slug>/snapshot"

The response includes `revision` and an ordered `blocks` array with deterministic refs (`b1`, `b2`, ...).

### Apply edits

  POST /documents/<slug>/edit/v2

Example:

  curl -X POST "http://localhost:4000/documents/<slug>/edit/v2" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer <token>" \
    -H "Idempotency-Key: <uuid>" \
    -d '{
      "by": "ai:your-agent",
      "baseRevision": 128,
      "operations": [
        { "op": "replace_block", "ref": "b3", "block": { "markdown": "Updated paragraph." } },
        { "op": "insert_after", "ref": "b3", "blocks": [{ "markdown": "## New Section" }] }
      ]
    }'

On success, the response includes the new `revision`, a `snapshot` payload, and a `collab` status.
If your `baseRevision` is stale, you'll receive `STALE_REVISION` plus the latest snapshot for retry.

v2 convergence fields:
- `collab.status` remains compatibility status (`confirmed|pending`) and is fragment-authoritative.
- `collab.fragmentStatus` and `collab.markdownStatus` expose render-vs-projection split directly.
- `202` is only expected when fragment convergence is pending.

Precondition contract for v2:
- `baseRevision` is required.
- `baseUpdatedAt` is not accepted on `/edit/v2`.

Idempotency guidance:
- Send `Idempotency-Key` for mutation requests (`X-Idempotency-Key` is also accepted for compatibility).
- `/edit/v2` examples include this header because block-level retries are common in automation.

Mutation contract discovery:
- Read `contract.mutationStage` from `GET /documents/<slug>/state` to detect Stage A/B/C rollout.
- `contract.idempotencyRequired` and `contract.preconditionMode` summarize current requirements.

Common mutation contract error codes:
- `IDEMPOTENCY_KEY_REQUIRED`: mutation request omitted idempotency key in required stage.
- `IDEMPOTENCY_KEY_REUSED`: same key reused with a different payload hash.
- `BASE_REVISION_REQUIRED`: stage requires `baseRevision` and request did not provide it.
- `LIVE_CLIENTS_PRESENT`: rewrite blocked because active authenticated collab clients are connected.
  Use `retryWithState` to refresh state, confirm `connectedClients === 0`, and if `forceIgnored=true` do not retry with `force` in hosted environments.
  This response is retryable and includes `reason` + `nextSteps`.
- `REWRITE_BARRIER_FAILED`: rewrite safety barrier failed before mutation; no rewrite was applied.
  This response is retryable and includes `reason` + `nextSteps`; retry with bounded exponential backoff and jitter.

## Line Marks, Issues And Alignment (Proof Documents, Step 1)

Every line of a document (a paragraph, heading, code block, list item or table row) can carry one
status mark per team member: `seen`, `agreed`, `approved` (owner credential only) or `rejected`
(needs a `reason`). Marks are stored beside the document; they never change its text. A mark
remembers a hash of the line's text, so when the line is edited the mark stops counting (it is
reported as changed) until that member marks the line again.

Read them with the state:

  GET /api/agent/<slug>/state

The response adds:
- `lines`: `[{ index, kind, hash, occurrence, block, ref, text }]` (`ref` is the snapshot block ref `b<N>`)
- `lineMarks`: `[{ id, by, status, reason, at, anchor: { hash, occurrence, ordinal, kind, excerpt } }]`
- `issues`: document-ordered list. A line is an Issue when a team member has not marked its current
  text (`unseenBy`, `changedFor`) or someone rejected it (`rejectedBy`). An open comment or a pending
  suggestion is also an Issue (`type: "comment" | "suggestion"`).
- `alignment`: `{ aligned, team, owners, counts }`. `aligned` is true when there are no Issues.
  Step 1 team = the owner, everyone who has line-marked, commented, replied or suggested, and
  every active agent key (as `ai:<key-name-slug>`).

Mark a line (commenter, editor or owner token):

  POST /api/agent/<slug>/marks/line
  Body: {"status": "seen", "by": "ai:your-agent", "quote": "text from the line"}

Target the line with exactly one of `lineIndex`, `hash` (+ optional `occurrence`), `ref`
(+ `quote` when the block holds several lines, such as a list or table) or `quote`. Use
`"status": "unseen"` to clear your mark, and `"reason"` with `rejected`. With an agent key you
always mark as the key's AI (`ai:<key-name-slug>`): omit `by`, or send exactly that. Errors: `409 ANCHOR_NOT_FOUND`,
`409 AMBIGUOUS_LINE` (returns `candidates`), `409 LINE_CHANGED` (the hash no longer exists; re-read
state), `403 OWNER_REQUIRED` (approve), `400 REASON_REQUIRED`, `403 ACTOR_MISMATCH` (see Identity
below). Changes also appear as `line_mark.updated` events.

### Sections, folding and batch marks (Proof Documents, Step B2)

A section is a top-level heading and everything after it until the next top-level heading of the
same or a higher level (an H2 section ends at the next H1 or H2). People can fold sections in the
editor. Folding is per viewer and view-only: it never changes the text, the marks or the Yjs state.

`GET /state` also returns `sections`: `[{ headingIndex, ref, level, text, lineEnd, parent, issues }]`.
Lines `headingIndex` to `lineEnd - 1` belong to the section. `parent` is the enclosing heading's
line index, or null. `issues` counts the line Issues inside the section. Review-mark Issues carry
no position in `/state`, so they are not counted here; the editor's section badge counts both.

Mark many lines in one request and one transaction (same route, same rules per line):

  POST /api/agent/<slug>/marks/line
  Body: {"status": "seen", "lines": [{"quote": "..."}, {"lineIndex": 7}, {"ref": "b4", "quote": "...", "status": "rejected", "reason": "..."}]}

Each entry is a target, exactly as in the single form, and may carry its own `status` and
`reason`. Mark a whole section by its heading:

  Body: {"status": "agreed", "section": {"quote": "Heading text"}}

A section can be marked `seen`, `agreed`, `approved` (owner credential) or `unseen`. `rejected` is
refused with `400 SECTION_REJECT_NOT_ALLOWED`, because a rejection needs a specific line and a
reason. A target that is not a top-level heading returns `409 NOT_A_HEADING`. In a batch, one bad
entry writes nothing, and the error carries its `index`. A request holds at most 1000 lines. A
batch is recorded as one `line_mark.batch` event (`count`, `statuses`, `anchors`). The page route
`POST /api/documents/<slug>/line-marks` takes the same batch as
`{ by, status, lines: [{ anchor, status?, reason?, replaceIds? }] }`.

## Asks: Decision Lines (Proof Documents, Step B3)

An **ask** turns one line of the document into a decision for named people. It follows the Pulse Zero card standard: one decision per ask; the question line carries its own context; the asker brings a **recommendation**, not a menu (Completed Staff Work); an optional one-line **ifYes** previews the consequence; the answer is a real control (**Yes / Not yet / No**) recorded in the person's exact words. An ask is stored beside the document, like a line mark (never in the text), and follows its line through edits.

Create an ask on an existing line (the target works like `/marks/line`: `lineIndex`, `hash`[+`occurrence`], `ref`, or `quote`):

```bash
curl -X POST "$BASE/api/agent/$SLUG/asks" -H "x-share-token: $KEY" -H 'Content-Type: application/json' \
  -d '{"quote": "Ship the ask control tonight?", "to": ["human:Mike"], "recommend": "Yes: every check passes", "ifYes": "The COS deploys at 06:00 UTC"}'
```

Or add a new line and make it an ask in one call (needs edit access): `{"insertAfter": {"quote": "..."} | "b7", "text": "Can we retire PM /review this week?", "to": [...], "recommend": "..."}`. The response carries `inserted: {ref, lineIndex, text}`.

- `to`: identities (`"human:mw@mike-wolf.com"`, `"Mike Wolf"`, `"ai:critic"`; see Identity below). Default: the document's owner (the member who created it). An empty list means any human other than the asker.
- `recommend` is required (400 `RECOMMEND_REQUIRED`). One ask per line (409 `ASK_EXISTS`: re-ask or withdraw instead).
- `by` is your key's AI; an agent key cannot act as a human or another AI (403 `ACTOR_MISMATCH`).

Read and act:

- `GET /api/agent/$SLUG/asks` lists every live ask: `question`, `recommend`, `ifYes`, `to`, `lineIndex`, `ref`, `status` (`open` / `snoozed` / `yes` / `no` / `mixed`), `openFor`, `snoozedFor`, `people[]` (each person's state, choice and words), `answers` (latest counting answer per person) and `history` (every answer ever given).
- `/state` includes the same list as `asks`; every open ask is an Issue of `type: "ask"` (`askId`, `openFor`, `recommend`), counted in `alignment.counts.askIssues` and in its section's count. Askers and the people asked join the team.
- Each answer emits an `ask.answered` event (`GET /events/pending`): `data.choice`, `data.words` (exact), `data.question`, `data.recommend`, `data.askedOf`; `actor` is who answered. Harvest answers from these events.
- `POST /asks/:id/answer` `{choice: "yes" | "not_yet" | "no", words}`: an AI answers an ask it was asked. `No` and `Not yet` need `words` (400 `REASON_REQUIRED`).
- `POST /asks/:id/reask` (asker or owner; may change `recommend`, `ifYes`, `to`) reopens it for everyone. `DELETE /asks/:id` withdraws it.

Rules (policy `ASK_POLICY` in `src/shared/asks.ts`): Yes and No close the ask for the person who answered. Not yet snoozes it for that person (not an Issue) until the question line's text changes or the asker re-asks. Any answer stops counting when the question line's text changes. An answer from someone not in `to` is recorded and shown but does not settle the ask. Answering marks the answerer's line Seen (never lowers a mark). A deleted question line leaves the ask `orphaned` (listed, not an Issue).

In the page: the question line shows an **Ask** tag and, under it, the recommendation and the Yes / Not yet / No buttons with a words field; the right rail and the phone sheet show the same control for the focus line. Keys while reading: **Y** yes, **N** no, **T** not yet (N and T open the reason field). Answering is an explicit action for the reading walk: it commits the scroll-accepts above the line. The page answers through `POST /api/documents/$SLUG/asks/:id/answer` `{by, choice, words, anchor}`, and reads asks from the line-marks poll (`GET /api/documents/$SLUG/line-marks` returns `asks`).

## Identity: who a mark or an answer names (Proof Documents, Step B6)

Line marks, asks and ask answers name one of three kinds of actor:

- `human:<email>`: a person the server verified. The page's request carried a Documents session
  (the `proof_library_session` cookie; with SOMA Auth on, only a session the server checked
  against SOMA Auth). People see the member's profile name, not the email.
- `ai:<key-name-slug>`: an AI that presented an "Add agent" key.
- `guest:<name>`: a share-link viewer who typed a name. It is shown with "(guest)" everywhere.
  Rows written before this step with a typed `human:<name>` are read as `guest:<name>`.

Who a request acts as (first match wins; policy `IDENTITY_POLICY` in `src/shared/identity.ts`):
an agent key acts as its own AI, and a `by` naming anyone else is `403 ACTOR_MISMATCH`; a signed-in
session acts as its person, and any `by` is ignored (a session request from another origin is
`403 CROSS_ORIGIN`); the owner credential (scripts) acts as the `by` it names, and may name
`human:<email>`; another share token may only name an `ai:` that is not an agent key's AI
(`403 AI_ACTOR_REQUIRED`, `403 ACTOR_RESERVED`); anyone else on the page is `guest:<typed name>`.

Asks: `to` entries may be `human:<email>`, an email, a member's display name (stored as that
member's `human:<email>`), `ai:<name>`, or another name (the guest who types it). An ask stored
before this step with a typed name keeps working: a name a member holds means that member, so a
guest typing the same name does not answer it. `to: []` (any human but the asker) counts verified
people and guests. Responses show the resolved `to`, and `toRaw` when the stored text differs.

Merges: marks written under a typed name before the person signed in stay readable and are never
rewritten. The COS can, on request, read them as that person:
`npx tsx server/library/cli.ts merge-identity --from "Mike" --into human:mw@mike-wolf.com --slug <slug>`
(or `--all-documents`; `unmerge-identity`, `list-merges`, `actors --slug <slug>`). A merge covers
only what the typed name wrote before the merge. Merged rows carry `originalBy`.

The page reads who it is from `GET /api/documents/<slug>/line-marks` (`identity.me`: `actor`,
`trust`, `name`, `signInUrl`) and shows it in the right rail header. Page routes for the asker or an
owner: `POST /api/documents/<slug>/asks/:id/reask`, `DELETE /api/documents/<slug>/asks/:id`.

## Honest reading, "Since you" and aligned snapshots (Proof Documents, Steps B3b and B3c)

How a mark was earned: every line mark carries `via`: `dwell` (the reading walk), `click`, `key`,
`section` (a folded section), `ask` (answering the line's ask marked it Seen) or `api` (an AI
through `/marks/line`, and older marks). `dwell` and `section` are passive.

Skimmed: status `skimmed` means the reader's focus passed the line faster than its reading time
(its words at the reader's rate, default 4 words/s, at least 0.25 s, at most 6 s; constants in
`READING_WALK`). It is not Seen: the line stays an Issue, and line Issues list `skimmedBy`.

Carry-forward: a mark now stores the line's whole text (`anchor.text`). When a line changes only
cosmetically (spacing, case, punctuation, or a small spelling fix; `classifyLineChange` in
`src/shared/line-change.ts`) every mark on it still counts, tagged carried. A number, a negation or
other meaning word, a name, or an added, removed or moved word is substantive and resets marks as
before. `/state` lists carried marks in `carriedMarks` (`markId`, `by`, `lineIndex`, `from`, `to`).

Since you: `GET /api/agent/<slug>/since-you` (the page: `GET /api/documents/<slug>/since-you`)
returns what changed since the caller last marked a line on purpose, or since the last aligned
snapshot when that is later: `edited`, `asks`, `rejections`, `suggestions`, `comments`, and
`ringers` (lines Seen only passively that changed or gained something since). Lists hold at most 50
items; `counts` has the totals. An agent key reads as its own AI; the owner credential may pass `?by=`.

Aligned snapshots: when the Issue count reaches 0 the server freezes the markdown, every counted
line mark (actor, status, via, hash), the asks with answers and the team (once per distinct aligned
state; the newest 50 are kept). `/state` shows it in `alignment.lastSnapshot`.

  GET /api/agent/<slug>/snapshots            newest first, with `ledger` and `json` links
  GET /api/agent/<slug>/snapshots/<id>.md    the markdown ledger
  GET /api/agent/<slug>/snapshots/<id>       the JSON (markdown, lineMarks, asks, team)

The page reads the latest from `GET /api/documents/<slug>/line-marks` (`alignedSnapshot`) and asks
the server to check with `POST /api/documents/<slug>/alignment-check` (the server decides).

## Presence And Event Polling

Poll for changes:

  GET /documents/<slug>/events/pending?after=<cursor>&limit=100

Ack processed events (editor/owner):

  POST /documents/<slug>/events/ack
  Body: {"upToId": <cursor>, "by": "ai:your-agent"}

## Archived Desktop Workflow

This repo is web-first. Desktop-native workflows are outside the public SDK scope and should be treated as separate implementation work.

## Projection Guardrails And QA

Operational metrics:
- `projection_guard_block_total{reason,source}`
- `projection_drift_total{reason,source}`
- `projection_repair_total{result,reason}`
- `projection_chars_bucket{source,le}`

Staging soak (live browser viewers + repeated `/edit` + `/edit/v2`):

  SHARE_BASE_URL=https://proof-web-staging.up.railway.app \
  SOAK_DURATION_MS=300000 \
  npx tsx scripts/staging-collab-projection-soak.ts

## Create A New Shared Doc

If you need to create a share from scratch, use:

  POST /documents

This is the canonical public create route.
Hosted Proof still accepts `POST /share/markdown` as a compatibility alias.
Legacy create routes like `/api/documents` are internal/legacy and may be warned or disabled on hosted environments.

## Recommended Workflow: Adding Content To An Existing Doc

This is the most reliable way to add a line, row, or section to an existing document:

### Step 1: Get the snapshot

  curl -H "Authorization: Bearer <token>" "http://localhost:4000/documents/<slug>/snapshot"

This returns clean markdown per block (no internal HTML tags) plus stable `ref` identifiers and a `revision` number.
### Step 2: Find the right block

Look through the `blocks` array for the block you want to edit or insert near. Each block has:
- `ref`: stable identifier (e.g., `b3`)
- `markdown`: the clean markdown content of that block
- `type`: block type (e.g., `paragraph`, `heading`, `table`)

### Step 3: Apply your edit

  curl -X POST "http://localhost:4000/documents/<slug>/edit/v2" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer <token>" \
    -H "Idempotency-Key: <uuid>" \
    -d '{
      "by": "ai:your-agent",
      "baseRevision": 128,
      "operations": [
        { "op": "insert_after", "ref": "b3", "blocks": [{ "markdown": "New content here." }] }
      ]
    }'

### Step 4: Handle conflicts

If you get `STALE_REVISION`, the response includes the latest snapshot — re-read the blocks and retry.

## Troubleshooting

### `ANCHOR_NOT_FOUND` on `/edit` replace or insert

The `/edit` endpoint searches for your `search` or `after` text in the document. If the document was previously edited by agents, it may contain internal `<span data-proof="authored">` HTML tags. The search now automatically falls back to matching against clean text (with tags stripped), so this should be rare. If it still fails, the text genuinely doesn't exist in the document — re-read state and verify.

### `LIVE_CLIENTS_PRESENT` on `rewrite.apply`

`rewrite.apply` is blocked when authenticated collaborators are connected. Outside hosted environments you can pass `"force": true`, but on hosted environments `force` is ignored. If you still prefer the safer path:
1. Use `/edit` or `/edit/v2` instead (they work with live clients).
2. Wait for clients to disconnect (poll `/state` and check `connectedClients`).

### Suggestion anchors not matching

`suggestion.add` now resolves quotes against clean text even when the stored markdown contains internal `<span data-proof="authored">` annotations. If you still get `ANCHOR_NOT_FOUND`, re-read state and verify the quote text genuinely exists.

### Document content looks corrupted after suggestion reject cycles

Repeated suggest/reject cycles on annotated documents now preserve stable suggestion anchors so the document text should remain unchanged. If you still see unexpected content drift, re-read `Accept: text/markdown` and report the exact request/response pair.

### `COLLAB_SYNC_FAILED` errors

Edits via the API can fail when a browser has the document open with an active Yjs collab session. The `/edit` and `/edit/v2` endpoints handle this gracefully, but `rewrite.apply` does not. If you hit this, retry after a short delay or use `/edit`/`/edit/v2` instead.
