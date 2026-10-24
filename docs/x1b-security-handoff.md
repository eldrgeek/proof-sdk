# X1b: agent-key security and the U1 bar

Branch: `codex/x1-agent-key`. Started at `4525356`; first merged `origin/deploy/vps` at `05ef0e0` (merge commit `863f23e`). This report supersedes the affected behavior and browser setup in [the X1 handoff](x1-agent-keys-handoff.md).

## Changes

1. **Presented invalid credentials return 401 on key management.** Revoked, unknown, empty, and conflicting invalid credentials cannot list, mint, or revoke keys. Share/bridge/bearer headers, query credentials, and share cookies are checked. Omitting credentials still gives editor rights until A2, as the code comment states.
2. **Revocation invalidates the issuing key's collaboration access.** Existing signed tickets already contain `tokenId`; it now follows the authenticated connection context. Authentication checks the key before and after asynchronous document loading. Revocation closes matching local sockets immediately, and every collaboration runtime checks the database before handling incoming messages. Deferred persistence also checks the key. The WebSocket regression obtains tickets through HTTP, verifies a successful write before revocation, verifies refusal afterward, and confirms that an unrelated client keeps writing. It also simulates another process revoking a key directly in the database and checks that the next write is rejected before reaching the live document.

   **Why per-key:** the existing ticket ID supports targeted revocation without a schema migration or an `access_epoch` bump. Other open pages retain their sessions. Notifications close sockets in the revoking process; database checks reject revoked tickets and incoming messages in other processes too.
3. **Key management is same-origin.** POST and DELETE reuse `requireLibraryJsonOrigin` and require JSON plus the public Origin. GET, mutations, and OPTIONS reject foreign and `null` origins. The endpoint guard runs before general CORS on both `/documents/...` and `/api/documents/...`. The client sends a JSON DELETE body. An additional check against the actual local server confirmed rejection even for an origin otherwise allowed by the general development CORS configuration.
4. **Limits use the proxy's client address.** With proxy trust enabled, `X-Real-IP` wins; otherwise the final `X-Forwarded-For` entry wins. Leading spoofed values cannot alter attribution or evade the address limit. Without proxy trust, both headers are ignored. Both checked-in nginx locations set `X-Real-IP $remote_addr` and overwrite `X-Forwarded-For $remote_addr`. The existing SOMA test fixture now distinguishes header names.
5. **Minting requires ACTIVE sharing, including for owners.** Paused-owner minting returns 403 before consuming mint limits. Existing owner page editing policy is retained.
6. **Page precedence is restored.** `/d/<slug>` prefers a valid query token, then a valid share cookie, and ignores authentication headers. Key management explicitly selects the header-aware mode. Tests include a viewer query plus editor header, a stale query plus valid cookie, and headers without query/cookie credentials.
7. **The local server serves the editor bundle used by the Add agent bar.** `/assets/` serves `dist/assets/` before any old copies in `public/`, using revalidation for stable bundle names. The browser test now uses actual server assets and runs the complete dialog flow at 1280 and 400 px, including button visibility, enabled state, and viewport bounds.

## Browser investigation and limitation

The exact reported Add agent timeout did **not** reproduce with the original browser test after a fresh build of the merge: it passed. Browser inspection at both widths found the correct accessible name, a visible/enabled button, and a working dialog when assets were supplied by interception.

A direct browser load without that interception did reproduce a page-startup failure: `GET /assets/editor.js` returned **404**. The Node server served `public/`, while share HTML referenced the build in `dist/`. The original test hid this problem by supplying files itself. The revised regression fails explicitly on that 404 before the server fix and passes afterward without asset interception. No speculative bar wiring change was made. The evidence does not establish the cause of the earlier asset-intercepting test's timeout.

Local setup used `PORT=44191`, a temporary `DATABASE_PATH`, a temporary snapshot directory, and `PROOF_PUBLIC_ORIGIN=http://127.0.0.1:44191`. Browser requests outside the local test origin were blocked. The two other requested browser suites start their own local fixtures.

## Failing-before / passing-after evidence

Every command captured its exit status separately using `cmd; rc=$?; echo "rc=$rc"`, without piping the command.

| Fix | Regression | Before | After |
| --- | --- | --- | --- |
| 1 | `agent-keys.test.ts`: revoked credential listing | 1 — returned 200 instead of 401 | 0 |
| 2 | `agent-key-collab-revocation.test.ts`: real connection and issued ticket | 1 — connection survived revocation | 0 |
| 3 | `agent-keys.test.ts`: form, foreign/null origins, preflights | 1 — form minted with 201 instead of 403 | 0 |
| 4 | `agent-keys.test.ts`: spoofed leading forwarded address | 1 — recorded spoofed address | 0 |
| 5 | `agent-keys.test.ts`: paused owner | 1 — minted with 201 instead of 403 | 0 |
| 6 | `agent-keys.test.ts`: viewer query and editor header | 1 — page incorrectly editable | 0 |
| 7 | `agent-key-dialog.browser.test.ts`: actual bundle response and both widths | 1 — bundle returned 404 | 0 |

## Final checks

- `npm test`: exit **0**.
- `npx tsx src/tests/agent-keys.test.ts`: exit **0**.
- `npx tsx src/tests/agent-key-collab-revocation.test.ts`: exit **0** (also included in `npm test`).
- `npx tsx src/tests/share-event-poller.test.ts`: exit **0**.
- `npx tsx src/tests/soma-app.test.ts`: exit **0**.
- `npx tsx src/tests/client-errors.test.ts`: exit **0**.
- `npx tsx src/tests/server-routes-and-share.test.ts`: exit **0**. 76 passed, 0 failed. Its existing external-server subsection was skipped because the default `http://localhost:4000/agent-setup` fixture was unavailable (reported status 0); the in-process route tests ran.
- `npm run build`: exit **0**.
- `SHARE_BASE_URL=http://127.0.0.1:44191 npm run test:agent-key-dialog`: exit **0**, at 1280 and 400 px.
- `SHARE_BASE_URL=http://127.0.0.1:44191 npx tsx src/tests/share-banner-presence-browser.test.ts`: exit **0**.
- `SHARE_BASE_URL=http://127.0.0.1:44191 npx tsx src/tests/soma-browser.test.ts`: exit **0**.
- `npx tsc --noEmit -p tsconfig.server.json`: exit **2**, both baseline and final; the same 162 diagnostics after normalizing shifted line/column positions, with **no new errors**.
- `npx tsc --noEmit -p tsconfig.json`: exit **2**, both baseline and final; the same 475 diagnostics after normalizing shifted line/column positions, with **no new errors**.
- `git diff --check`: exit **0**.

Per-command logs are in the system temp folder as `/tmp/x1b-*.log`. Dialog screenshots are `/tmp/proof-x1b-agent-dialog-1280.png` and `/tmp/proof-x1b-agent-dialog-400.png`.

No push, deployment, VPS operation, or live nginx change was performed.
