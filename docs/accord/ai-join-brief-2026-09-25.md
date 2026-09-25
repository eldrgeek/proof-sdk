# Brief: an AI joins an Accord from its URL (2026-09-25)

_Brief by Claude Opus 5.5 (CCc session 1997a29b, the reviewer) for Mike Wolf, 2026-09-25. Builder: Codex (seat `codex-builder`). Bead `ac-220`. Branch `codex/accord-ai-join`, cut at `affc095` (live `da432e6` plus the bridge credential fix, bead ac-ok7)._

## Why

Mike, 2026-09-25, verbatim: "can you provide a way for an AI in our estate (or another) to join an accord just by me providing the URL".

Today an AI joins only through a key a person makes with Add agent: the person names the AI, copies a block of instructions that contains the key, and pastes it into the AI's chat (`src/editor/index.ts` `getAgentInviteMessage`, `server/agent-key-routes.ts`). A plain URL already lets an AI read (the viewer route answers JSON or markdown to a non-browser client, `server/share-web-routes.ts`), but nothing tells it how to join, and no route lets it ask.

Mike's ruling of 2026-09-19 (cross invitation, `src/shared/cross-invitation.ts` header) stands: every agent key has a human sponsor, admitted from the sponsor's live session and never with a share token; a declared runtime; a rate limit; and an AI may not admit another AI. So the URL is how the AI finds its way, and one click by a person is how it gets in.

## What to build

The flow, in the order it happens:

1. Mike gives an AI the Accord's plain URL, for example `https://proof.vpsmikewolf.duckdns.org/d/<slug>`.
2. The AI GETs that URL as a non-browser client. The JSON, markdown and agent-HTML answers, and `/.well-known/agent.json`, now say how to join: `POST /api/agent/<slug>/join` with its name and runtime. The old hint "Ask for a tokenized link" goes.
3. The server records a join request and answers `202` with: `requestId`, a short `code` that a person can read aloud (for example `KITE-4821`), a `pollToken` returned only this once, `expiresAt` (15 minutes), and the poll URL. The AI tells the person: "I asked to join. Admit code KITE-4821 in the Accord."
4. Everyone who may add agents to that document sees the request in the page, at once: a notice with "<name> (<runtime>) asks to join · code KITE-4821 · Admit · Refuse", and the same row in the Share dialog's AIs tab. "May add agents" is exactly the rule `server/agent-key-routes.ts` `authorize` applies today (edit rights, plus a signed-in sponsor whenever `sponsorRequiredFor(slug)` is true).
5. Admit creates an ordinary labelled agent key, the same row Add agent creates (`createDocumentAccessToken(..., 'editor', ..., { label, sponsor..., runtime })`), with the admitting person as sponsor. It is listed, revocable and suspended exactly like one made with Add agent. Refuse closes the request.
6. The AI polls `GET /api/agent/<slug>/join/<requestId>` with header `x-join-token: <pollToken>`. The answer is `pending`, `refused`, `expired`, or `admitted` with the key. The key is handed over once: the server keeps the plain secret only until that poll or the request's expiry, whichever comes first, then forgets it. After that the AI works through the existing agent API with `x-share-token`.

Rules:

- A request is open for 15 minutes. At most 5 requests may be open per document; the rate limits of agent-key creation apply per document and per address. Put every number in a policy object, `AGENT_JOIN_POLICY` in a new `src/shared/agent-join.ts`, with the header comment stating the rule and this brief as its source.
- An AI's key cannot admit or refuse a request (the depth cap). A share token cannot either: only a person's live session, or an anonymous page editor where the guest setting is `edit` (the same exception Add agent has).
- The code shown to the AI and the code shown in the page are the same, so a person can tell two requests apart. Never put the poll token or the key in a URL, a log line, an event or the page.
- `AGENT_JOIN_POLICY.autoAdmit` exists and is `false`. Mike has not ruled on letting estate AIs join without a click; the switch only makes that ruling a one-line change later.
- A private document (guest setting `private`) answers a join request exactly like its viewer URL does today (401), so the join route reveals nothing the URL does not.

Docs: add a section "Joining an Accord from its URL" to `docs/agent-docs.md`, served at `/agent-docs`, and describe the flow in the JSON `agent` descriptor (`server/proof-sdk-routes.ts`) and `/.well-known/agent.json` (`server/discovery-routes.ts`). Keep `AGENTS.md` and `CLAUDE.md` identical if you touch either (`src/tests/agents-claude-sync.test.ts`).

## Done means

- A unit suite, `src/tests/agent-join.test.ts`, wired into `npm test`: create a request; poll pending; a person's session admits it; the poll returns the key once and never again; the key reads `/api/agent/<slug>/state` and posts a comment attributed to the AI with its sponsor; refuse; expiry; the open-request cap; the rate limit; an agent key and a share token are refused as admitters; a private document answers 401; the poll token is never echoed by any other route.
- A browser check, `scripts/agent-join-check.mjs`, desktop 1440 in both review styles (`PROOF_DEFAULT_REVIEW_STYLE=playmaker|proof`): an AI (the script, through HTTP) asks to join; the page shows the request with the same code; clicking Admit admits it; the AI polls, gets its key, and comments; the page shows the comment by the AI, "added by" the person. Viewport screenshots to `.preview/agent-join-<style>-1440-*.png`. The Codex sandbox cannot start Chromium, so write the check and say so; the reviewer runs it.
- `npx tsc --noEmit -p tsconfig.json` adds no diagnostics in the files you touched.
- Your final report (the `-o` file) lists what you built, what you ran with its result, and what you did not verify.

## Out of scope

Anything on the live server, `~/proof-data`, keys or mail; deploying; the Accord editor's other steps (discussions, chat, dragging); changing Add agent itself; auto-admission.
