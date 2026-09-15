# E1: remote updates during editor loading

Branch: `codex/e1-nodesize-during-load`

Base: `a3a2ce542b9379c37265d9318198fbadfdea1d6a`

Verified locally on 2026-09-15; no VPS access, deployment, or push.

## Root cause

The undefined read is `(mapping.get(contentType)).nodeSize` in `node_modules/y-prosemirror/src/lib.js:184`, reached through the cursor plugin's relative-position conversion. Proof synchronously delivered the shallow Yjs marks-map observer (`src/bridge/collab-client.ts:614` on the base) into `applyRemoteMarks`, before y-prosemirror's deep fragment observer rebuilt the mapping for newly inserted paragraphs. Thus Yjs already contained the new nodes while the editor and mapping still described the previous document; the suggestions interceptor at `src/editor/index.ts:5506` was only forwarding the transaction, and without a remote cursor the same ordering could overwrite the inserted text silently.

## Changes

- `src/bridge/collab-client.ts`: coalesce remote marks notifications into a microtask and read the latest map after Yjs observers finish. Check document identity so a disconnected room's queued notification cannot affect a new room. Log delivery failures with the Error object and explicit stack, flush buffered local edits, and reload the server-backed page; log caught durable-replay failures too. Change two token callbacks' disconnected fallback from `null` to an empty string to satisfy the provider's callback type, removing this file's two existing type errors.
- `src/tests/collab-load-remote-update-regression.test.ts`: reuse the earlier test's local Express/Hocuspocus harness and the existing regression's Playwright loader. Exercise insert (including new blocks), replace, delete, comment, and reply during initial rendering, with another local editor's selection beyond the inserted blocks. Compare exact plain text and all returned mark identities and relevant display metadata against `GET /api/agent/<slug>/state`. Cover token and tokenless links, capture full browser Error descriptions through CDP, map stacks when a source map exists, and inject a one-time marks-delivery error in a fresh document to verify logging and actual reload/recovery.
- This report records evidence and the additional review-race limitation below.

The production Vite configuration and dependency installations were unchanged. Source maps were generated with the CLI override `npx vite build --sourcemap`; final validation used the regular `npm run build` output. Playwright's browser was installed under `/tmp/proof-e1-browsers`; the existing external Playwright package and symlinked dependencies were read only.

## Reproduction and before/after output

Run from the repository root, with `PROOF_PLAYWRIGHT_PACKAGE_JSON` pointing to the package.json beside an installed Playwright package. This run used Chromium 1234 and `PLAYWRIGHT_BROWSERS_PATH=/tmp/proof-e1-browsers`.

```sh
npm run build; rc=$?; echo "rc=$rc"
npx vite build --sourcemap; rc=$?; echo "rc=$rc"
npx tsx src/tests/collab-load-remote-update-regression.test.ts; rc=$?; echo "rc=$rc"
```

The first successful browser reproduction ran before any production source edits. The finalized regression was also rerun against a bundle built from the exact base version of the changed client file; the fixed source was restored immediately after that build.

Base output:

```text
Error: Client errors during load:
Caught error while handling a Yjs update TypeError: Cannot read properties of undefined (reading 'nodeSize')
    at node_modules/y-prosemirror/src/lib.js:184:63
rc=1
```

Fixed output (the logged injected error between the loading cases and recovery PASS is intentional):

```text
Loading burst (token): five operations in 1180ms
PASS: loading insert, replace, delete, comment and reply converge
events/pending (token): [200,200,200]
Loading burst (no token): five operations in 1242ms
PASS: loading insert, replace, delete, comment and reply converge
events/pending (no token): [200,401,200]
PASS: failed update logs its stack and reloads into server state
rc=0
```

The tokenless page's poll returned 401 while text and marks converged. The list also includes the authenticated witness page's 200 responses. The authenticated reproduction fails without any 401, so X1 is not required to trigger E1; the poll is unchanged.

## Validation

Each command was run directly with output redirected to its own log, immediately followed by `rc=$?; echo "rc=$rc"`; no test exit code was obtained through a pipe.

| Command | Exit code |
| --- | --- |
| `npm run build` | 0 |
| `npx vite build --sourcemap` (base diagnostic bundle) | 0 |
| New regression, base bundle | 1 (expected `nodeSize` failure) |
| New regression, fixed regular build | 0 |
| `npm test` | 0 |
| `npx tsx src/tests/collab-rest-suggestion-live-persistence-regression.test.ts` | 0 |
| `npx tsx src/tests/collab-live-typing-canonical-write-regression.test.ts` | 0 |
| `npx tsx src/tests/track-changes-race.test.ts` | 0 |
| `npx tsx src/tests/suggestions-key-by-key.test.ts` | 0 |
| `npx tsx src/tests/collab-concurrent-typing-browser.test.ts` | 0 |
| `npx tsc --noEmit -p tsconfig.json` | 2 |

The final type check reports **zero diagnostics in either changed TypeScript file**, and 537 diagnostics elsewhere. Those other files were left alone.

## Additional review-race finding (unresolved)

Accept and reject were also exercised in the page while a real API comment update was delivered. The optional probes hold inbound WebSocket delivery until the API write completes, then release it concurrently with the editor review action. Both can return success from the page while the suggestion remains pending or is restored in canonical state. Broader simultaneous-write experiments also produced repeated projection repairs and, in some runs, stack overflows. This is not resolved by the marks-observer ordering fix.

The retained probes deliberately require the review to persist as well as client/server convergence; they are separate from the loading regression so that an existing review failure cannot obscure the E1 result:

```sh
npx tsx src/tests/collab-load-remote-update-regression.test.ts --review-race=accept; rc=$?; echo "rc=$rc"
npx tsx src/tests/collab-load-remote-update-regression.test.ts --review-race=reject; rc=$?; echo "rc=$rc"
```

| Probe | Base exit | Fixed exit |
| --- | --- | --- |
| `--review-race=accept` | 1 | 1 |
| `--review-race=reject` | 1 | 1 |

Both base probes fail waiting for the review and remote comment to converge, confirming a pre-existing defect. This change fixes E1's loading failure; it does **not** claim that overlapping review and agent writes are fully correct.

## Full source-mapped baseline stack

```text
Caught error while handling a Yjs update TypeError: Cannot read properties of undefined (reading 'nodeSize')
    at II (node_modules/y-prosemirror/src/lib.js:184:63 (http://127.0.0.1:63741/assets/editor.js:54:38921))
    at node_modules/y-prosemirror/src/plugins/cursor-plugin.js:101:20 (relativePositionToAbsolutePosition)
    at Map.forEach (<anonymous>)
    at yDe (node_modules/y-prosemirror/src/plugins/cursor-plugin.js:85:25 (http://127.0.0.1:63741/assets/editor.js:54:40053))
    at Rs.apply (node_modules/y-prosemirror/src/plugins/cursor-plugin.js:180:18 (createDecorations))
    at B6.applyInner (node_modules/prosemirror-state/dist/index.js:836:45 (http://127.0.0.1:63741/assets/editor.js:38:25413))
    at B6.applyTransaction (node_modules/prosemirror-state/dist/index.js:796:45 (http://127.0.0.1:63741/assets/editor.js:38:24695))
    at B6.apply (node_modules/prosemirror-state/dist/index.js:772:21 (http://127.0.0.1:63741/assets/editor.js:38:24370))
    at aOe.dispatch (node_modules/prosemirror-view/dist/index.js:5918:37 (http://127.0.0.1:63741/assets/editor.js:44:50964))
    at h (src/editor/index.ts:5506:11 (originalDispatch))
    at o.dispatch (src/editor/index.ts:5542:13 (dispatchWithRevision))
    at xf (src/editor/plugins/marks.ts:1034:8 (http://127.0.0.1:63741/assets/editor.js:84:4027))
    at AKt (src/editor/plugins/marks.ts:1991:3 (finalizeMarkTransaction))
    at src/editor/index.ts:5019:7 (applyRemoteMarks)
    at v9.action (node_modules/@milkdown/core/lib/index.js:663:29 (action))
    at Kin.applyExternalMarks (src/editor/index.ts:5015:17 (http://127.0.0.1:63741/assets/editor.js:1464:1188))
    at Kin.applyLatestCollabMarksToEditor (src/editor/index.ts:5034:12 (http://127.0.0.1:63741/assets/editor.js:1464:1565))
    at Dv.marksHandler (src/editor/index.ts:1530:18 (http://127.0.0.1:63741/assets/editor.js:1195:11160))
    at Array.<anonymous> (src/bridge/collab-client.ts:614:12 (http://127.0.0.1:63741/assets/editor.js:683:70222))
    at qae (node_modules/lib0/function.js:20:11 (http://127.0.0.1:63741/assets/editor.js:50:53057))
    at ANe (node_modules/yjs/dist/yjs.mjs:1987:3 (f.callAll))
    at MG (node_modules/yjs/dist/yjs.mjs:5001:3 (callEventHandlerListeners))
    at EI._callObserver (node_modules/yjs/dist/yjs.mjs:6065:5 (callTypeObservers))
    at Array.<anonymous> (node_modules/yjs/dist/yjs.mjs:3268:22 (http://127.0.0.1:63741/assets/editor.js:52:21610))
    at qae (node_modules/lib0/function.js:20:11 (http://127.0.0.1:63741/assets/editor.js:50:53057))
    at PNe (node_modules/yjs/dist/yjs.mjs:3305:7 (callAll))
    at fa (node_modules/yjs/dist/yjs.mjs:3428:9 (cleanupTransactions))
    at iqt (node_modules/yjs/dist/yjs.mjs:1652:3 (transact))
    at SG (node_modules/yjs/dist/yjs.mjs:1747:3 (readUpdateV2))
    at cle (node_modules/yjs/dist/yjs.mjs:1761:58 (applyUpdateV2))
    at Nje (node_modules/@hocuspocus/provider/dist/hocuspocus-provider.esm.js:2112:5 (Y.applyUpdate))
    at Jnn (node_modules/@hocuspocus/provider/dist/hocuspocus-provider.esm.js:2153:7 (readUpdate))
    at Dje.applySyncMessage (node_modules/@hocuspocus/provider/dist/hocuspocus-provider.esm.js:2226:33 (readSyncMessage))
    at Dje.apply (node_modules/@hocuspocus/provider/dist/hocuspocus-provider.esm.js:2188:22 (http://127.0.0.1:63741/assets/editor.js:683:44670))
    at ern.onMessage (node_modules/@hocuspocus/provider/dist/hocuspocus-provider.esm.js:2672:38 (http://127.0.0.1:63741/assets/editor.js:683:55392))
    at znn.onMessage (node_modules/@hocuspocus/provider/dist/hocuspocus-provider.esm.js:1882:105 (http://127.0.0.1:63741/assets/editor.js:683:41231))
    at node_modules/@hocuspocus/provider/dist/hocuspocus-provider.esm.js:1579:52 (http://127.0.0.1:63741/assets/editor.js:683:35737)
    at Array.forEach (<anonymous>)
    at znn.emit (node_modules/@hocuspocus/provider/dist/hocuspocus-provider.esm.js:1579:23 (http://127.0.0.1:63741/assets/editor.js:683:35724))
    at WebSocket.u (node_modules/@hocuspocus/provider/dist/hocuspocus-provider.esm.js:1821:52 (http://127.0.0.1:63741/assets/editor.js:683:40062))
```
