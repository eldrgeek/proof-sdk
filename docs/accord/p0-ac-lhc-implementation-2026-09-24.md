# ac-lhc implementation and verification

Built by Codex (GPT-6), seat `codex-builder`, on 2026-09-24, from Mike's P0 brief and the reviewer's decided design. Branch: `codex/accord-p0-marks-guard`. Changes are uncommitted for the reviewer.

The four fixes are implemented. `npm run build` and `npm test` pass on Node **v22.22.3**. Chromium cannot start in this sandbox, so the restart browser check has **no result**. The reviewer still needs to establish failure on the unfixed build and success on this build.

## 1. Server guard

Files: `server/collab-marks-guard.ts`, `server/collab.ts`, `src/shared/suggestion-status.ts`.

The guard attaches in all **three** `afterLoadDocument` hooks present in this checkout. Attachment is idempotent per Y.Doc. A client deletion of an insert, delete or replace whose status is neither accepted nor rejected restores its old value synchronously. The restoration uses origin `server-pending-suggestion-restore`. Each restoration records `suggestion.deletion_restored` with `markId`, `kind` and `by`; it records no document text.

Client pending-to-accepted/rejected transitions record `suggestion.accepted` or `suggestion.rejected`. A transition back records `suggestion.reopened`. Server transactions, including remote Yjs replay with a server origin, are excluded. Deletion of an already resolved entry is allowed. The REST engine therefore keeps its own events without a second record from the observer.

**Client origin evidence:** installed Hocuspocus **2.15.3**, `node_modules/@hocuspocus/server/src/MessageReceiver.ts`, calls `readSyncStep2` and `readUpdate` with the `Connection` as origin. Those updates produce `transaction.local === false`. The guard requires both conditions: `!transaction.local` and `transaction.origin instanceof Connection`. Local=false alone would also catch server replay.

`src/tests/pending-suggestion-guard.test.ts` invokes Hocuspocus's actual receiver for SyncStep2 and Update messages. It verifies that origin, the separate local restoration transaction, one restoration event, status decisions/reopening, resolved deletion and server deletion. It decodes Hocuspocus's actual outgoing broadcast into a second replica and checks convergence. This is an in-process transport test, not a browser/socket test.

Restoration happens in the map observer, before `afterTransaction` and `update` persistence listeners. The test calls the real collab persistence helper from those update notifications. A SQLite trigger rejects **any** document revision without the pending suggestion, not merely the final state. Both `documents.marks` and `document_projections.marks_json` retain it.

## 2. Resolution by status

Files: `src/editor/plugins/marks.ts`, `src/formats/marks.ts`, `src/shared/suggestion-status.ts`, `server/document-engine.ts`, `server/blind-view.ts`, `server/agent-routes.ts`, `server/routes.ts`.

Accept/reject in an editor bound to Yjs retain the record with `status`, `resolvedBy` and `resolvedAt`. The text-edit branches are unchanged. Native decision history restores the exact prior pending record and text on Undo, and the resolved record on Redo. Batch decisions retain the same behavior. Headless REST operations retain their existing removal/tombstone contract.

Metadata normalization and snapshot building keep resolved records for live synchronization. Editor mark collection excludes them even when an old inline anchor survives briefly. Remote pending snapshots cannot undo a local decision before its acknowledgement; an authoritative pending record following server finalization can reopen it. A separate server-finalization tombstone lets an authoritative guard restore re-anchor immediately after a transient wire deletion, while stale passive merges remain suppressed. The client test exercises that delivery order without changing the text.

Reader checks:

- Editor marks/decorations and thread conversion exclude resolved suggestions from open items.
- The existing Review list, line Issues, aligned status, Since you, bundle locator, library counts and dialect export already use status or filtered editor marks. The new reader test exercises state, line Issues, Review counts, Since you and the bundle locator with pending, accepted and rejected records.
- `/state` retains the durable status. The agent engine treats a repeated same-status decision as already done. An opposite REST decision now returns `MARK_ALREADY_RESOLVED` without applying text again; guarded editor Undo is how a decision is reopened.
- New decision attribution fields in page document/open-context reads and agent state follow whole-span reveal. Decision events are omitted when current anchors cannot prove reveal. Tests cover unrevealed, partially revealed and fully revealed spans. These tests do not establish a new per-viewer privacy boundary for the shared Yjs transport.
- The impact report reads `document_line_marks`, not suggestion metadata. Its existing synthetic tests pass in `npm test`.

`src/tests/pending-suggestion-client.test.ts` exercises the real accept/reject functions, native decision history, all three suggestion kinds, exact text outcomes, attribution, status persistence, decorations and thread readers. `src/tests/pending-suggestion-readers.test.ts` covers server readers and blind decision fields/events. The existing four concurrency/Undo cases in `review-decision-collab.test.ts` pass unchanged.

Only the authorised Yjs-resolution contract assertions in `share-live-collab-resolution-routing.test.ts` changed: resolved records remain present with accepted/rejected status. The no-REST-call assertions and all other existing assertions remain unchanged.

## 3. Passive snapshots

Files: `src/bridge/collab-client.ts`, `src/editor/plugins/marks.ts`.

`setMarksMetadata` preserves a current pending suggestion omitted from any supplied snapshot. Both empty and partial payloads are tested against the actual client method.

`mergePendingServerMarks` retains missing pending server suggestions and preserves explicit local resolved status or a resolution tombstone. It keeps its existing behavior of discarding stale local pending metadata when the server has finalized it. The editor's retained resolved metadata carries live decisions to the shared map.

The old `shouldPreserveMissingLocalMark` helper and its legacy contract were not repurposed. The pending-suggestion preservation rule is applied explicitly at the outgoing snapshot boundary.

## 4. Reconnect race and browser check

Files: `src/editor/index.ts`, `scripts/marks-restart-check.mjs`, `package.json`.

**Exact missing step:** after `onMarks` stores the incoming entries while the editor is structurally empty, `applyLatestCollabMarksToEditor` returns. Later, `kickCollabHydration` finishes and calls `markInitialCollabHydrationComplete`, but that completion previously only set a boolean. It did not retry the deferred marks application. This source path explains the reviewer's recorded sequence of two received marks and zero editor marks at flush; I could not reproduce that sequence in a browser here.

Hydration completion now retries the stored marks. Editable anchoring waits for sync and the correct live ProseMirror/Yjs binding. Read-only metadata delivery still works without granting anchor-writing capability. `resetShareMarksSyncState` clears a separate anchoring gate. `flushShareMarks` retries anchoring and returns without publishing if that gate is not ready.

The new `check:marks-restart` command builds fresh fixtures through HTTP. It adds replace and insert suggestions only through the agent API, opens an editor-role guest, restarts on the same database/port, reconnects the same page, then navigates it to `about:blank` or hides it through Chromium's lifecycle command. The hidden variant requires a real `visibilitychange` event. It checks `/state`, `documents.marks` and the projection. It runs ten iterations per style **per variant**: forty by default. It does not write marks directly or use live data.

`P0_OLD_BUILD_DIR` adds forty old-page/new-server transition iterations. `--reinit` additionally invokes the existing public share-runtime activation path. Neither variant is claimed to be a deterministic reproduction: Chromium was unavailable, so that still needs measurement.

## Verification and limitations

- `npm run build`: **passed**. Only existing bundler warnings were printed.
- `npm test`: **passed**, all 38 wired commands, including `test:marks-restart`.
- `npm run test:marks-restart`: **passed** again after strengthening the broadcast test.
- `npx tsc --noEmit -p tsconfig.json`: **475 diagnostics**, identical to an untouched HEAD extracted into `/tmp` using the same installed dependencies. No new diagnostics, including in touched files.
- Additional `src/tests/marks.test.ts` run: three failures, exactly reproduced on untouched HEAD. They concern contextual target metadata with stale relative anchors, Markdown-flavoured target metadata and canonical block separators. No assertions were edited to conceal them.
- `node --check scripts/marks-restart-check.mjs` and `git diff --check`: **passed**.
- `npm run check:marks-restart`: **attempted once, blocked at Chromium launch**. macOS reported `bootstrap_check_in ... MachPortRendezvousServer ... Permission denied (1100)` and Chromium exited with SIGTRAP. No browser iterations ran. No browser success, unfixed-build failure or transition success is claimed.

Local run logs: `/tmp/ac-lhc-build-final.log`, `/tmp/ac-lhc-verification.log`, `/tmp/ac-lhc-focused-final.log`, `/tmp/ac-lhc-browser.log`, `/tmp/ac-lhc-types-final.log`, `/tmp/ac-lhc-types-baseline.log`, `/tmp/ac-lhc-marks2.log`, `/tmp/ac-lhc-marks-baseline.log`.

The bead take and work-claim commands were attempted. The sandbox denied writes to the estate bead lock and `active-work.jsonl`; no claim was created to release. Nothing was committed, pushed or deployed. `.preview/`, `.p0-ref/`, live documents and the VPS were not changed.

Reviewer commit trailers: `Bead: ac-lhc`, `Seat: codex-builder`, author `Codex <codex@openai.com>`. Include the actual browser results in `Verified:` after running the outstanding checks.

## Round 2: concurrency, version admission, pruning and replay

Round one is retained on parent `bb8bdb8`. The four parts above still describe the implementation. The race's missing step remains the retry from `markInitialCollabHydrationComplete` into `applyLatestCollabMarksToEditor`; no new race mechanism is asserted. The actual Hocuspocus receiver still supplies `local === false` and a `Connection` instance as origin. `pending-suggestion-guard.test.ts` exercises both Update and SyncStep2, checks the named server restore transaction, rejects any persisted row missing either pending suggestion, and decodes the second connection's broadcast.

### A. Restore concurrency

`server/collab-marks-guard.ts` checks that the key is absent both before starting the restore transaction and inside it. A write made by another observer or a transaction-start listener is not replaced. Restoring remains synchronous: this preserves the round-one guarantee that persistence listeners never see a missing suggestion. Only closing a connection is deferred until a microtask, after repaired updates have been broadcast.

`pending-suggestion-concurrency.test.ts` uses the actual Hocuspocus message receiver and tests a newer accepted value written before, during and after the restore observer. The round-one persistence and broadcast tests continue to prove the synchronous location is safe.

### B. Limit repeated restores

`src/shared/suggestion-status.ts` defines three restores in a rolling five-minute window. The guard counts restored keys per `Connection` in a weak map. On the third it makes that connection read-only immediately, records `collab.reload_required` with the reason and count, logs the socket ID, then closes with code 4401 and reason `client-upgrade-required`. The event contains no document text. All deleted keys in the current transaction are restored before the close.

The concurrency test covers the threshold, window expiry, separate connections, one reload event, and broadcast-before-close ordering. `collab-version-replay.test.ts` also reaches the threshold on a real socket and verifies that Hocuspocus stops reconnecting.

### C. Version admission and what 0913728 sees

Files: `src/shared/collab-version.ts`, `server/client-capabilities.ts`, `server/routes.ts`, `server/collab.ts`, `server/ws.ts`, `src/bridge/share-client.ts`, `src/bridge/collab-client.ts`, `src/editor/index.ts`.

The fixed web client advertises version `0.32.0`. Live sessions require at least that version, a nonempty build, and protocol `3`. The existing three headers supply these fields. Session issuance through `open-context`, `collab-session` and `collab-refresh` uses the existing HTTP 426 / `CLIENT_UPGRADE_REQUIRED` response. The session builder itself refuses missing or obsolete versions. Normal agent REST operations retain their existing compatibility contract.

The browser socket does not send these HTTP headers. `getProviderParameters` sends the signed session token in the query and Hocuspocus also authenticates with that token. Issuance now signs the client fields into the token. The WebSocket router, authentication hook and pre-message hook check them. Tokens issued by older servers have no client fields and are refused. Unversioned tokens are never silently labelled as current.

Code 4401 is Hocuspocus's terminal Unauthorized close. The provider used by 0913728 sets `shouldConnect = false` for it. The old tab cannot sync an accept, reject or flush. The fixed client flushes its durable queue, stops its refresh timer and shows **“Reload this page to resume editing. Your unsent changes stay in this tab.”** with a **Reload** button. Reload is deliberate; no automatic navigation destroys the editor or its queued updates.

**Unmet part of C for the immutable old page:** 0913728 has no reload-specific UI. On an existing session it shows **“Offline - reconnecting”**, or **“Offline - unsaved changes”** if it has unsynced changes. Its provider stops socket retries, but its editor still tries HTTP session refresh on its existing recovery timer (roughly six seconds), and can do so every two seconds near token expiry when there are no pending edits. HTTP 426 makes that old refresh method return without replacing the editor or clearing the queue. A fresh share initialization that gets 426 displays the upgrade error and does not retry initialization. The new server cannot change these timers or labels in JavaScript already loaded from 0913728. Thus zero repeated HTTP requests from an already-open 0913728 page is not achieved; the current client stops them. This limitation must not be described as a fully fixed old-client retry loop.

The version/replay suite exercises all three HTTP routes, missing/outdated/incomplete versions, signed version fields, refusal of old tokens at both token delivery paths, and terminal provider behavior. Current-client test fixtures now use the current version; their existing assertions are unchanged. The three direct session-builder fixtures explicitly supply current client metadata.

### D. Prune resolved records

`pruneResolvedSuggestions` in `server/collab-marks-guard.ts` runs from `persistDoc` before the snapshot and projection are written. It deletes accepted/rejected suggestions only when `resolvedAt` is strictly more than 24 hours old, using `server-resolved-suggestion-prune`. It retains pending suggestions, the exact 24-hour boundary, future timestamps and missing/unparseable timestamps. Unknown dates do not prove the Undo window has expired.

Round one's resolved-entry exclusion from anchoring, decorations, Review, line Issues, aligned status, Since you, bundle counts and blind decision metadata remains unchanged. The reader/client suites remain wired into `npm test`. The concurrency suite tests the time boundary and origin. The version/replay suite verifies actual persist-time removal from the live map and `documents.marks`, and delivery to another client.

### E. Same-tab durable replay

`collab-version-replay.test.ts` constructs an unsent Yjs update containing both an old-page deletion and a text insertion in the real ProseMirror fragment. It stores the encoded update under `proof:collab:pending-updates:<slug>:same-tab`, with the durable ID in session storage. It runs the production `loadDurableBuffer` and `replayDurableUpdates` methods, then sends the replay through a current, signed Hocuspocus session. The guard restores the pending suggestion and records the restore. The inserted editor text survives in both the live fragment and persisted Markdown. Reload refusal also leaves the local queue intact.

The browser transition variant now expects the old page to be refused before reloading the same tab into the fixed build. It observes HTTP 426 and then checks the retained pending suggestions after reconnection and navigation/hiding. It still creates all fixtures and suggestions through the API, never by directly modifying marks. No deterministic browser trigger is claimed.

### Round-two verification

- Node **v22.22.3**, with `/Users/mikewolf/.local/bin` first in PATH for every command.
- `npm run build`: **passed** (`/tmp/ac-lhc-round2-build.log`).
- `npm test`: **passed**, all **38 wired groups**, including the two added suites inside `test:marks-restart` (`/tmp/ac-lhc-round2-test-final.log`). The first run stopped at the caret suite's obsolete client-version fixture; updating current-client fixture headers fixed it without changing assertions.
- TypeScript: **475 diagnostics**, identical to parent `bb8bdb8` with the same dependencies after normalizing checkout paths and source line numbers. **No new diagnostics** (`/tmp/ac-lhc-round2-tsc-final.log`, `/tmp/ac-lhc-round2-baseline-tsc.log`).
- Existing test assertion lines were compared against HEAD: **none changed in round two**. Round one's single authorized routing-contract change remains in the parent.
- `git diff --check` and `node --check scripts/marks-restart-check.mjs`: **passed**.
- Browser check attempted once: **Chromium could not start** (`bootstrap_check_in ... MachPortRendezvousServer ... Permission denied (1100)`, SIGTRAP). No iterations ran. No pass/fail result for restart, hide, old-build transition or deterministic reproduction is claimed (`/tmp/ac-lhc-round2-browser.log`).

0913728's UI and refresh-timer behavior were checked in its source using `git show`; they were not observed in a running browser. The installed Hocuspocus provider's terminal socket behavior, current-session replay, restored peer delivery and persisted text were exercised over loopback sockets. The remaining old-page HTTP-refresh limitation is described under C above.

No commit, deployment, live document, `.preview/` or `.p0-ref/` changes were made in this round. The reviewer still owns the browser run and commit.

Final focused rerun: `npm run test:marks-restart` **passed** after adding non-vacuous peer-pruning and projection assertions (`/tmp/ac-lhc-round2-focused-final.log`). The supplemental session-epoch eviction and active-lease suites **passed**. The supplemental session-version eviction suite printed its passing assertion result but did not exit; it was interrupted after waiting, so it is not reported as a clean test-process pass (`/tmp/ac-lhc-round2-session-fixtures.log`). Those supplemental suites are outside `npm test`.
