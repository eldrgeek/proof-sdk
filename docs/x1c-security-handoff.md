# X1c: revoked keys cannot obtain fresh editing sessions

Branch: `codex/x1-agent-key`, starting at `e0b5b4c`. Read the X1b review's three remaining findings and “Disposition of all six earlier findings.”

## Ticket issuance

All production calls to `buildCollabSession` are in `server/routes.ts`. These are the complete HTTP issuance paths:

| Method | Route | Alias |
| --- | --- | --- |
| GET | `/documents/:slug/collab-session` | `/api/documents/:slug/collab-session` |
| GET | `/documents/:slug/open-context` | `/api/documents/:slug/open-context` |
| POST | `/documents/:slug/collab-refresh` | `/api/documents/:slug/collab-refresh` |

All three now use `resolveOpenContextAccess`. It validates each presented share header, bridge header, bearer header, query `token`, and document share cookie, including empty values and credentials shadowed by another valid credential. It also validates the existing body `ownerSecret` input. An unresolved credential returns 401 with no session, before the collaboration-disabled fallback. Valid share keys retain their `tokenId` in the ticket. No-credential requests retain editor access until A2.

The old test accepting an unresolved `epsess_` bearer was updated to require 401. Hosted OAuth is unsupported in this SDK; the existing owner OAuth validation hook remains, but an unvalidated bearer is never treated as anonymous.

The new `agent-key-session-issuance.test.ts` is included in `npm test`. On unchanged `e0b5b4c` production code it revoked key A, presented A to `/documents/:slug/collab-session`, and failed with **200 instead of 401**. After the fix, it passes across every route and alias, every credential source, empty/unknown/revoked credentials, conflicting sources, repeated query values, valid-key authentication and key identity, and tokenless editing.

## Dialog

The requested text appears directly under the key list:

> Revoking stops that key from working. While this document can be opened from its link without signing in, anyone who has the link can still edit it.

It appears when the page lacks the existing server-injected `__PROOF_LIBRARY_MEMBER__` marker. An anonymous display name is not membership. Team-only document policy remains for A2. Browser coverage checks the exact text and position at both viewport widths and its absence with the signed-in member marker. That member rendering check supplies the marker in the browser; real session-to-marker injection remains covered by `library.test.ts`.

## X1b preserved and remaining limits

No changes were made to key-management CSRF/CORS guards, client-address attribution, paused-share minting, page query/cookie credential precedence, or collaboration revocation guards. Their existing regressions pass.

- **Until A2:** a visitor who omits all credentials still has editor access through the secret slug, including listing, minting, and revoking keys. X1c deliberately retains this policy.
- **Multiple processes:** revocation disconnects matching sockets in the revoking process. Another process rejects the revoked key on its next incoming message, but a passive socket there can still receive broadcasts until then. Cross-process broadcast revocation remains unimplemented. The stated live deployment uses one process.

## Browser investigation

Built the actual editor assets, then started a fresh local server with `NODE_ENV=development`, `PORT=44194`, `PROOF_PUBLIC_ORIGIN=http://127.0.0.1:44194`, and fresh temporary `DATABASE_PATH` and `SNAPSHOT_DIR`. Ran the browser suite **three consecutive times** against this server. Every run passed, including visible/enabled/in-viewport Add agent buttons at 1280 and 400 px, the full mint/copy/list/revoke flow, the new copy conditions, and polling/backoff checks. The reported missing-button timeout did not reproduce; no button or wait workaround was added. Browser requests outside the local origin were blocked, and assets came from the real server without interception.

Screenshots: `/tmp/proof-x1c-agent-dialog-1280.png` and `/tmp/proof-x1c-agent-dialog-400.png`. The mobile screenshot was visually checked: the notice wraps below the key list and remains readable.

## Checks and exit codes

Every command captured its exit status separately as `cmd; rc=$?; echo "rc=$rc"`, without a pipe.

- `npx tsx src/tests/agent-key-session-issuance.test.ts` before the fix: **exit 1** (`/tmp/x1c-issuance-before.log`).
- `npx tsx src/tests/agent-key-session-issuance.test.ts` after the fix: **exit 0** (`/tmp/x1c-issuance-after.log`).
- `npm test` after item 1: **exit 0** (`/tmp/x1c-npm-test-item1.log`).
- `SHARE_BASE_URL=http://127.0.0.1:44194 npm test` on the final code: **exit 0** (`/tmp/x1c-npm-test-final.log`).
- `npx tsx src/tests/agent-keys.test.ts`: **exit 0** (`/tmp/x1c-agent-keys.log`).
- `npx tsx src/tests/agent-key-collab-revocation.test.ts`: **exit 0** (`/tmp/x1c-collab-revocation.log`).
- `npx tsx src/tests/server-routes-and-share.test.ts`: **exit 0**, 76 passed, 0 failed (`/tmp/x1c-server-routes.log`). The existing optional `/agent-setup` subsection was skipped: no server on port 4000 in the standalone run, and the fresh port-44194 server returns 404 for that endpoint in the final `npm test`. In-process route coverage ran in both cases.
- `npm run build`: **exit 0** (`/tmp/x1c-build.log`).
- Browser run 1, `SHARE_BASE_URL=http://127.0.0.1:44194 npm run test:agent-key-dialog`: **exit 0** (`/tmp/x1c-browser-1.log`).
- Browser run 2, same command: **exit 0** (`/tmp/x1c-browser-2.log`).
- Browser run 3, same command: **exit 0** (`/tmp/x1c-browser-3.log`).
- `npx tsc --noEmit -p tsconfig.server.json`: **exit 2** before and after; the same 162 diagnostics after normalizing line/column shifts, with no new errors (`/tmp/x1c-ts-server-{before,after}.log`).
- `npx tsc --noEmit -p tsconfig.json`: **exit 2** before and after; the same 475 diagnostics after normalizing line/column shifts, with no new errors (`/tmp/x1c-ts-{before,after}.log`). An intermediate run identified three type errors in the new test's inferred header union; an explicit credential type fixed them before final validation.
- `git diff --check`: **exit 0**.

Two commits cover the ticket fix and dialog change, respectively. No push, remote-server operation, deployment, or upstream PR was performed. The local test server was stopped after validation.
