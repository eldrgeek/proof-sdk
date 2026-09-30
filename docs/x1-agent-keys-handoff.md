# X1: Working, revocable agent keys

Base: `e805019`. Branch: `codex/x1-agent-key`.

## What people can do

Open a document without a token, choose **Add agent**, name the agent (default: **AI assistant**), and choose **Create agent key**. The dialog shows and copies instructions containing a real editor credential in `x-share-token`. Each invitation gets its own key, including invitations from pages that already have a credential. The document link contains no credential.

The same dialog lists each agent key's label, creation time, last use, and revocation status. **Revoke** disables that key immediately; subsequent agent state and operation requests return 401. Existing document access links are excluded from this list and cannot be revoked through this endpoint.

## Implementation

- `server/share-page-access.ts`: `resolveSharePageAccess` is the shared decision for opening the live page and managing agent keys. It preserves tokenless editor access and valid-query/cookie fallback, and accepts the editor's forwarded credential header. SOMA library sessions identify the requester without introducing a sign-in requirement. Future page-access policy belongs here.
- `POST /api/documents/:slug/agent-keys` accepts `{label}` and creates an `editor` access token through `createDocumentAccessToken`. Only this response returns the secret, with `Cache-Control: no-store`.
- `GET /api/documents/:slug/agent-keys` returns metadata; `DELETE /api/documents/:slug/agent-keys/:tokenId` revokes a single agent key. All three require the shared page decision's `canEdit` permission. Revoked, deleted, missing, and non-owner paused documents fail with 403, as do viewer/commenter credentials.
- An additive SQLite migration adds label, requester, client address, and last-use fields to `document_access`. Requesters are recorded as a library member ID, access-token ID, document owner, or anonymous page editor with client address. Secrets remain hashed at rest.
- Minting uses independent limits of 10 requests/document/minute and 30 requests/client-address/minute. It uses the existing in-memory server rate limiter and `getClientIp`, respecting `PROOF_TRUST_PROXY_HEADERS`. Budgets are per server process and reset on restart.
- Keys stay in the creation response and the open dialog's memory. Closing the dialog clears its instructions. Key management does not put secrets into URLs, logs, error messages, local storage, or metadata-list responses.

## What the poll does

`GET /api/agent/:slug/events/pending` reads durable document events. The editor uses comment/suggestion events to refresh authoritative marks and document/agent edit events to request a document or collaboration-session refresh. Healthy Yjs sessions already receive live document changes, so the editor skips forced collaboration refreshes while such a session is healthy. The event poll provides an additional fallback, including for changes delivered through another server instance.

Before X1, tokenless pages repeatedly got 401 and received none of these fallback signals. X1 starts no poll without an explicit page share credential; it also guards direct client fetches. Tokenless pages still lack that fallback, while existing WebSocket/Yjs delivery continues. Agent keys are not reused as page credentials and are never added to the page URL.

Credentialed polls retry after 3 and 6 seconds following the initial 1.5-second poll, then stop after three authentication failures. Other failures also back off exponentially, capped at 30 seconds; success restores the normal interval. Teardown cancels scheduling, including when a request is in flight.

## Validation

Each command's exit code was captured separately with `cmd; rc=$?; echo "rc=$rc"`, without a pipeline. Tests used local servers and temporary databases.

- `npm test`: exit **0**, including the new agent-key API and poll behavior tests.
- `tsx src/tests/server-routes-and-share.test.ts`: exit **0**; 76 passed, 0 failed. The suite's legacy onboarding-route subsection skipped because this fork returns 404 for `/agent-setup`; this also applies to the `npm test` run.
- `tsx src/tests/agent-keys.test.ts`: exit **0**. Covers tokenless creation, read-only/unavailable denial, requester attribution, state and actual operation execution, immediate revocation, secret hygiene, independent limits, and trusted/untrusted forwarded addresses.
- `tsx src/tests/share-event-poller.test.ts`: exit **0**. Covers no credential, exact exponential scheduling, three-request ceiling, success recovery, credential loss, teardown, and the client's direct-fetch guard.
- `npm run test:agent-key-dialog`: exit **0**. Chromium covers the actual tokenless editor's Add agent dialog, naming, real displayed/copied key, metadata list, revoke, zero tokenless polls, no minted credential in request URLs, and three exponentially delayed 401 polls on a credentialed page.
- `tsx src/tests/share-pill-agent-stack.test.ts`: exit **0**.
- `tsx src/tests/share-client-access-link-compat.test.ts`: exit **0**.
- `tsx src/tests/share-client-keepalive-base-token.test.ts`: exit **0**.
- `npm run build`: exit **0**.
- `tsc --noEmit`: exit **2**, both before and after the change. Both runs contain the same 475 diagnostics after normalizing shifted line/column positions; there are no new errors, including in touched files.
- Extra existing check, `tsx src/tests/share-event-poll-fallback-wiring.test.ts`: exit **1**. The exact test and source files extracted from `e805019` also exit **1** at the same assertion. It expects WebSocket-recovery methods absent from that base (`updateShareEventPollForSocketState`, `runShareEventPollPass`, `catchUpShareEventPollAfterSocketRecovery`, `pauseShareEventPoll`). This pre-existing source-contract failure is unchanged; the new behavior tests exercise the implemented poller.

### Browser test setup

Build with `npm run build`, then run a local server with a temporary `DATABASE_PATH` and a chosen `PORT`. Run `SHARE_BASE_URL=http://127.0.0.1:<port> npm run test:agent-key-dialog`. Playwright and its Chromium browser are required. The test serves built assets through browser request interception because this fork's Node server delegates those assets to its front proxy. Nonlocal page requests are blocked. The initial harness runs exposed missing asset serving and the existing first-visit display-name prompt; the final harness supplies assets and completes that prompt.

No push or deployment was performed. No remote server was modified.
