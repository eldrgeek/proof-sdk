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
