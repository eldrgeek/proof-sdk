# P0 ac-lhc: pending suggestions deleted after a server restart

_Written by Claude Opus 5.5 (CCc, seat ccc-adhoc) on 2026-09-24 for Mike Wolf, during the Accord usability job. It records the evidence, the mechanism, the reproduction, and the fix design. The fix design is the reviewer's technical decision, and Mike can overrule it._

## Summary

The wave-2 deploy did not cause this bug. It exposed it. The bug is in the live build (wave 1, 0913728) and in wave 2 (d15df82). It is probably older, because the code involved is older than the usability work.

When the server restarts while a document is open in a browser tab, that tab reconnects. Sometimes, during the reconnect, the tab's editor loses its copy of the pending suggestions. The next time the tab flushes its marks, it sends the editor's list to the shared document. That flush runs when the tab is hidden, closed or reloaded. The shared document treats a suggestion missing from that list as resolved, so it deletes it. The server saves the deletion without an event.

Every deploy restarts the server. So any deploy can delete pending suggestions from a document that someone has open. Tabs running the previous build do the deleting, so a fix in the new client alone cannot prevent it. The server must refuse these deletions.

## The incident

- The scratch document `c0qr3avn` had two pending suggestions: a replace by `ai:check` (created through the agent API) and an insert "a" by `human:Claude` (typed in the old client at 06:24 UTC).
- The pre-wave-2 backup (10:11 UTC) shows both suggestions in every copy of the marks: the `documents.marks` row, the projection, the compacted Yjs state and the Yjs snapshot plus updates. Nothing was out of step.
- At 10:12:06.579 UTC the server logged Yjs update 2200: source `collab`, 33 bytes, no new content, only deletions. It removed both entries from the Yjs `marks` map. The server wrote revision 9 with `marks = {}` 3 ms later, with no event.
- The browser tab that did it had been open since 06:23 UTC on the old client. Its console shows several reconnects, an expired collab session token, and a 502 during the 10:11 deploy. At 10:12:01 the reviewer loaded the new client in that same tab.

## Reproduction

The reviewer copied only this document's rows out of the pre-wave-2 backup (on the VPS; no other document left the server), then replayed the tab's history against local servers. The harness is `replay2.mjs` in the reviewer's scratchpad. It opens the page, stops the server, starts a server on the same port and database, waits for the page to reconnect, then navigates the same tab.

| Sequence | Result |
|---|---|
| Fresh browser opens the document on wave 2, no restart | kept |
| Old page (0913728) open, server swapped to wave 2, same tab loads the document again | deleted |
| Same, but the old page only reconnects and is never navigated | kept |
| Same, but the document is opened in a new tab and the old tab is closed | kept |
| Wave 1 page, wave-1 server restart, same tab reloads | deleted |
| Wave 2 page, wave-2 server restart, same tab reloads | deleted |
| Wave 2 page, no restart, same tab reloads | kept |
| Old page, server swapped to Cursor's fix (362edeb), same tab reloads | deleted |
| Instrumented wave 2 page, restart, same tab navigates to `about:blank` | deleted |

The deletion is a race: the same sequence deletes in about one run in four. The last row matters most. The deletion reached the server with no next page at all, so the old page's own socket delivered it while unloading.

## The mechanism (file references are to d15df82)

1. A server restart makes the open page restart its share runtime. `initFromShare` calls `resetShareMarksSyncState()` (`src/editor/index.ts:1505`, defined at `:1939`), which empties `lastReceivedServerMarks`. Activation also sets `collabCanEdit = false` (`:1787`).
2. The server then sends both marks again (`collabClient.onMarks`, `:1612`). They are stored, but the editor does not re-anchor them. `applyExternalMarks` hydrates anchors only when `collabCanEdit` is true (`:6074`), and `applyLatestCollabMarksToEditor` returns early while the editor document is structurally empty (`:6081`). The instrumented run logged: marks received 2, then at flush time the editor held 0.
3. `flushShareMarks` (`:6165`) runs on `beforeunload`, `pagehide` and `visibilitychange` (`:1439`, `:1462`, `:1469`). It computes `mergePendingServerMarks(editorMarks, lastReceivedServerMarks)` (`src/editor/plugins/marks.ts:1766`). That function treats a suggestion missing from the editor as resolved locally, so the result was empty. It then calls `collabClient.setMarksMetadata({})` (`:6201`).
4. `setMarksMetadata` (`src/bridge/collab-client.ts:846`) treats its argument as the complete list and deletes every other key (`:874`). `shouldPreserveMissingLocalMark` refuses to preserve suggestions on purpose (`src/bridge/marks-preservation.ts:7`), because a connected accept or reject resolves a suggestion by deleting its key. The test `share-live-collab-resolution-routing.test.ts` requires this: connected accept and reject make no REST calls, and the resolved suggestion must be absent from the Yjs map.
5. The server persists the client's update (`persistDoc` → `appendYUpdate`, source `collab`) and materializes `documents.marks` without the suggestions. No event is written, because the server sees an ordinary client update.

## Why the earlier fixes did not hold

- Cursor round 1 (ec08088) guarded `setMarksMetadata` against passive removal and added a check. The check passed on the unfixed build, so it never reproduced the incident.
- Cursor round 2 (362edeb) built a two-build check. Its fixture deleted the Yjs marks map by hand ("simulated deploy mismatch") and then showed that the new client lost the marks. The live backup shows that mismatch never existed. On the faithful replay, 362edeb still deletes, because the deleting page runs the previous build.

## Live exposure

- Wave 1 is live with this bug. The live server restarts only on a deploy, a crash, or memory above 700 MB (it uses 65 MB). So the controllable risk is our own deploys. **Do not deploy or restart the live server until the server guard below ships.**
- No real document lost a suggestion today: all 53 documents with 196 pending suggestions at 06:21 UTC still have them.
- Earlier history, checked across every backup since 09-14: 57 suggestions vanished without an event between 09-19 23:22 and 09-21 22:09 UTC. In `ttq18nc1`, a rewrite by `ai:ask-mike` removed 35 of them, and that rewrite also changed the text. So those were not this bug. In `uxqgozvm`, Mike's 18 pending inserts vanished at 00:39 UTC on 09-20, about an hour after a deploy, with no logged update. Every one long enough to judge still has its text in the document. So either Mike accepted them or this bug removed their markers. No text was lost either way. The remaining 4 cannot be traced because their history was compacted.

## Fix design (reviewer's decision)

The principle: the editor's marks are a view. Their absence must never delete a pending suggestion from the shared document. Only an explicit decision may resolve one.

1. **Server guard (required; it protects tabs running an older build during a deploy).** Observe the Yjs `marks` map of every loaded live document. When a transaction applied from a client update deletes a key whose old value is a pending suggestion, restore that key at once in a server-origin transaction. Log one event per restore. Deleting an entry whose status is already `accepted` or `rejected` stays allowed. Server-side transactions (the agent API and the document engine) are unaffected.
2. **Resolution by status.** A connected accept or reject sets `status` to `accepted` or `rejected` on the map entry, with who and when. It no longer deletes the key. Undo sets it back to `pending`. The routing test's "absent from the Yjs marks map" assertion changes to "present with a resolved status". That is a contract change, and the reviewer authorises it.
3. **Passive snapshots never delete pending suggestions.** `setMarksMetadata` never deletes a pending entry. `mergePendingServerMarks` keeps a server suggestion that is missing from the editor unless this client resolved it.
4. **Fix the race itself.** After a share re-init, re-anchor the pending suggestions once the text is loaded and edit capability is known. `flushShareMarks` must not write marks before that has happened.

## Rejected alternatives

- Ignoring empty payloads (362edeb). It targets a state that did not happen, and it leaves the flush path open.
- Letting the server accept a deletion only when the same update also changes the text. That is fragile, and it depends on how marks are encoded in the fragment.
- Routing every resolution through REST. That reverses the upstream design for connected clients and adds a round trip to every accept.
