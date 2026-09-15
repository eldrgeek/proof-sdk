# X1e: key revocation removes AI presence

Base: `4835cf0` on `codex/x1-agent-key`.

## Delivered

1. Authenticated reads, explicit presence, and mutation presence/cursors carry the creating `document_access` token ID. Authentication captures that ID before asynchronous work; request bodies cannot set it. Owner/member/tokenless participation has no key attribution.
2. Local key revocation removes matching presence and cursor records using the same Yjs deletion and broadcast functions as inactivity expiry. Timers are cancelled. Revoked records are pruned during room loading, and delayed writes cannot recreate them.
3. The existing bar restores **Add agent** when the last AI disappears. The new browser regression starts its own server with `COLLAB_EMBEDDED_WS=1`, reads with two keys, revokes them in the dialog, checks both open pages within five seconds, and verifies both pages after reload and collaboration sync. No frontend implementation change was necessary.
4. The server regression verifies B and unkeyed owner presence/cursors remain byte-for-byte unchanged when A is revoked. Existing socket revocation assertions remain intact.

Items 1, 2, and 4 form one server change (`b6f0a66`). Item 3 is a separate browser regression commit. No deployment or upstream PR was performed.

## Test-first evidence

Only tests were changed before the first failures on `4835cf0`. The final regression files were also replayed in a detached worktree at that revision.

| Regression | Base exit code | Fixed exit code | Base failure |
| --- | ---: | ---: | --- |
| `agent-key-collab-revocation.test.ts` | 1 | 0 | A presence remains immediately after revocation |
| `agent-key-dialog.browser.test.ts` | 1 | 0 | Two-AI bar does not fall to one within 5 seconds |

The browser harness initially checked for the asynchronous name prompt too early. Two setup attempts exited 1 because its overlay intercepted clicks. The harness now waits for anonymous continuation on the first page; the shared browser context retains that choice on the second page. These setup failures are distinct from the reproduced revocation failure.

## Required final commands

Each command captured its own exit code with `rc=$?; echo "rc=$rc"`, without a pipe. Test output stayed in local `/tmp/proof-x1e-*.log` files; credentials were not printed.

| Command | Exit code |
| --- | ---: |
| `npm run build` | 0 |
| `npm test` | 0 |
| `npx tsx src/tests/agent-key-duplicate-cookies.test.ts` | 0 |
| `npx tsx src/tests/agent-key-session-issuance.test.ts` | 0 |
| `npx tsx src/tests/agent-keys.test.ts` | 0 |
| `npx tsx src/tests/agent-key-collab-revocation.test.ts` | 0 |
| `npx tsx src/tests/agent-presence-lifecycle.test.ts` | 0 |
| `npx tsx src/tests/server-routes-and-share.test.ts` | 0 |
| `env -u SHARE_BASE_URL npx tsx src/tests/agent-key-dialog.browser.test.ts` | 0 |
| `npx tsx src/tests/share-banner-presence-browser.test.ts` | 0 |
| `npx tsc --noEmit` | 2 |
| Comparison of touched-file type diagnostics against base | 0 |
| `git diff --check` | 0 |

Type checking has 48 pre-existing diagnostics in the touched files on both base and final source, with zero new diagnostics (comparison ignores shifted line numbers).

## Run history

- Build: base 0; initial fixed 0; final 0.
- `npm test`: initial fixed 0; final 0.
- Six explicitly requested server/unit commands: initial fixed 0 each; final 0 each.
- Server regression standalone: initial base 1; initial fixed 0; final base replay 1 (its two required suite runs also exited 0 above).
- Dialog browser: base setup attempt 1; base behavioral failure 1; fixed setup attempt 1; corrected fixed run 0; final base replay 1; final fixed run 0.
- Share-banner browser: initial fixed 0; final 0.
- Type check: base 2; initial fixed 2; final 2. Both diagnostic comparisons exited 0.
- Diff checks and commits exited 0.
