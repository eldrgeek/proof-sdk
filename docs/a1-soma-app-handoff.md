# A1 handoff — Accord as a SOMA app

## Result

Worked only on `codex/a1-soma-app`. Starting HEAD was `f88d25c`. The first repository mutation merged `origin/deploy/vps` at `17c6e45` (merge commit `0b0f243`). No push, deployment, VPS operation, or Supabase configuration change was performed. Reference projects were read only.

Implementation commits:

1. `526ffbb` — Sign in to the library with SOMA Auth and manage members.
2. `69962da` — Send feedback from every Accord page to the app builder.
3. Final implementation commit — Report browser errors to the builder and show delivery in the editor.

## File-by-file changes

| File | Change |
| --- | --- |
| `.env.example` | Documents disabled-by-default library, SOMA auth, and feedback settings; includes no credentials. |
| `docs/self-hosting.md` | Describes flags, provisioning responsibilities, membership, daily role checks, proxy configuration, vendoring, and report behavior. |
| `docs/a1-soma-app-handoff.md` | This implementation and validation record. |
| `package.json` | Includes SOMA auth, feedback, and client-error tests in the normal test commands. |
| `server/client-address.ts` | Extracts the existing trusted-proxy resolver, preserving `PROOF_TRUST_PROXY_HEADERS` behavior. |
| `server/routes.ts` | Uses the extracted helper for the existing share limiter and proxy trust checks. |
| `server/db.ts` | Adds dated SOMA privilege fields to hashed library sessions and the `client_errors` aggregate table. Also includes the required merge's existing H1 schema change. |
| `server/library/auth.ts` | Verifies Supabase user identity and `is_app_admin` with the user's token; admits admins/active members; reuses hashed sessions; expires and refreshes daily admin authority; uses the shared IP resolver. |
| `server/library/routes.ts` | Adds CSRF-protected `/library/api/session`; disables legacy sign-in/device routes under SOMA auth; makes member addition admin-only in that mode; returns added members without sign-in links. |
| `server/library/cli.ts` | Removes `signin-link`; retains the five requested commands. |
| `server/library/page.ts` | Renders SOMA sign-in, removes the device UI in SOMA mode, offers member addition to admins, and injects the chip/identity on signed-in and signed-out pages. |
| `server/library/soma-page.ts` | Sends public env configuration and ordered classic script tags with a pinned Supabase UMD version. |
| `server/library/client.js` | Handles SOMA sign-out, admin-only member addition, read-only People for members, and legacy flag-off UI compatibility. |
| `public/vendor/soma-auth/soma-auth.js` | Verbatim reference browser runtime copied from Legends. |
| `public/vendor/soma-auth/soma-auth-config.js` | Accord identity config: magic link and Google only. |
| `public/vendor/soma-auth/proof-session.js` | Exchanges the browser access token, displays denial/errors, handles login methods, and schedules daily checks at the server's lease deadline. |
| `public/vendor/soma-feedback/soma-feedback.js` | Verbatim canonical chip v4.1, copied 2026-09-15. |
| `public/vendor/soma-feedback/soma-feedback.css` | Verbatim canonical chip stylesheet. |
| `scripts/sync-soma-feedback.sh` | Re-copies canonical assets or checks byte equality with `--check`. |
| `server/soma-feedback.ts` | Express same-origin proxy, credential stripping, session-derived admin token, unchanged JSON response passthrough, health probe, and JSON failures. |
| `server/soma-page.ts` | Safely injects chip CSS/script, member identity, build/area configuration, and the early error reporter. |
| `server/client-errors.ts` | Bounds/redacts reports, rate-limits by the shared address resolver, persists/deduplicates 30-minute windows, and forwards one credential-free report per signature/window. |
| `server/index.ts` | Mounts feedback and error routes. |
| `server/share-web-routes.ts` | Uses a replacement callback for member injection, removes GET visit writes, sends protected POST visits after editor readiness, and injects editor feedback/reporting. |
| `src/ui/name-prompt.ts` | Makes the signed-in member's name win before reading browser storage. |
| `src/editor/index.ts` | Signals editor readiness after successful initialization, including the rendered fallback, so the injected client can POST an open visit. |
| `src/index.html` | Preserves dismissible error banners and appends delivery confirmation only after report acceptance. |
| `public/js/proof-client-errors.js` | Captures browser errors/rejections and the specific Yjs caught-error log; limits to five reports; reads diagnostic fields only; deduplicates event/banner reporting. |
| `src/tests/library.test.ts` | Retains flag-off L1 coverage and adds stored-name and replacement-metacharacter regression assertions. |
| `src/tests/soma-app.test.ts` | Covers auth outcomes, cookies/hashes, CSRF, daily demotion/refresh, role spoofing, member administration, removed paths, proxy-aware limits, and protected visits. |
| `src/tests/soma-feedback.test.ts` | Covers proxy security, body preservation, clarify/accepted passthrough, health/failure behavior, flags, identity, and all requested page embeds. |
| `src/tests/client-errors.test.ts` | Covers caps, redaction, dedup windows, per-IP limits, no credentials, delivery failures, and the browser reporter in an isolated runtime. |
| `src/tests/soma-browser.test.ts` | Local Chromium test of reference-runtime login methods, token exchange, People, sign-out, chips, and actual editor error-banner scripts. All upstream requests are stubbed. |
| `tsconfig.json` | Changes `rootDir` to the repository root because existing client tests import server/package sources outside `src`; retains `noEmit`. |
| `server/collab.ts` | Unmodified beyond the required H1 merge. |
| `src/tests/collab-live-connection-heartbeat-regression.test.ts` | Added by the required H1 merge; not otherwise modified. |

## Validation

Commands were run locally, with each shell exit code captured immediately as `rc=$?; echo "rc=$rc"`, without a pipeline. Supabase and feedback fetches in the added tests are stubs. The Chromium regression uses only local services; the SOMA browser test intercepts the CDN runtime with a test double and rejects unexpected external browser requests.

| Command | Final exit code |
| --- | --- |
| `npm test` | 0 |
| `npm run test:library` | 0 |
| `npx tsx src/tests/library.test.ts` | 0 |
| `npx tsx src/tests/soma-app.test.ts` | 0 |
| `npx tsx src/tests/soma-feedback.test.ts` | 0 |
| `npx tsx src/tests/client-errors.test.ts` | 0 |
| `npx tsx src/tests/soma-browser.test.ts` | 0 |
| `npx tsx src/tests/server-routes-and-share.test.ts` | 0 (76 passed) |
| `npx tsx src/tests/share-live-collab-resolution-routing.test.ts` | 0 |
| `npm run build` | 0 |
| `npx tsx src/tests/collab-rest-suggestion-live-persistence-regression.test.ts` (after build) | 0 |
| `scripts/sync-soma-feedback.sh --check` | 0 |
| `npx tsc --noEmit -p tsconfig.server.json` | 2, before and after |
| `npx tsc --noEmit -p tsconfig.json` | 2, before and after |

Intermediate runs: the new SOMA browser test returned 1 twice while its selectors were being corrected (two matching “New document” buttons; then trying to click a banner underneath the newer Yjs banner). Its final run passes. An intermediate server type check caught a missing import for the extracted proxy-trust helper; that was fixed. All other completed test/build runs returned 0. Type checks consistently returned 2 because of existing diagnostics.

Diagnostic counts count lines containing `error TS`, after the required merge and before implementation versus the final implementation:

| Type check | Before | After | New diagnostics |
| --- | ---: | ---: | ---: |
| Server | 162 | 162 | 0 |
| Client | 535 | 477 | 0 |

Diagnostics were compared by file, error code, and message with line/column positions normalized. There are no new diagnostics in touched files or elsewhere. The client reduction is 58 pre-existing `rootDir` diagnostics; this is not a clean type check. The build also retains its existing large-bundle warning.

Canonical byte equality was checked for the Auth runtime and both feedback assets. Feedback JS SHA-256: `50b4567c8f39301a98090bae4d630d61474031fea2f33b9d14851b00afbd20d2`. Auth runtime SHA-256: `c113e77fa3626f191b605842adfa87f8c19651279ccb4980ec883fd955ad3d27`.

## Resolutions and departures

- **Flag-off compatibility versus link removal:** the brief asks both to remove L1 link sign-in and to preserve base behavior with flags off. The old web paths and link helpers remain solely for the SOMA-auth-off fallback. With SOMA auth on, sign-in/device endpoints return 404 (including case/trailing-slash variants). The CLI command is removed unconditionally, as explicitly requested.
- **PlayMaker method mismatch:** its checked-in config currently also enables passwords. Accord follows the brief's explicit magic-link-and-Google decision; it does not offer passwords.
- **Daily role checks without storing tokens:** the server cannot call the user-token RPC later without the browser supplying a token. It therefore gives admin authority a hard 24-hour lease; the browser renews at that deadline. A stale lease fails closed while ordinary active membership continues. The token is never stored in SQLite.
- **Client type-check configuration:** `rootDir` now covers the existing server imports in client tests, preventing new path diagnostics without suppressing errors or emitting files.
- **Error-forwarding failure:** failed reports remain recorded locally and are suppressed for the rest of that signature's 30-minute window. The editor never claims delivery for those failures. This follows the one-forward-per-window requirement; an automatic retry/outbox was not added.
- **Production round trip:** actual Google/email delivery, the redirect allow-list, admin role provisioning, and live builder delivery remain COS deployment checks. No real Supabase or feedback service was contacted. The admin queue page and document access control remain out of scope.
