# Accord as a room surface: recommendations and prototype

_Written 2026-11-05 by Claude (Claude Code, Accords project thread "AC: Prototype Accord as a room surface") for Mike Wolf. Mike's direction that day: an Accord becomes a surface inside a SOMA Room; Accord Chat goes away; room members, AIs and humans, are the Accord's participants; strip what Rooms makes redundant. And: "The chat in a room with an accord should move with the accord." He asked for recommendations to try out ("We are exploring"). Every recommendation below is built in the prototype, and each is a switch in `ROOM_SURFACE_POLICY` (`src/shared/room-surface.ts`) that he can overrule._

## Recommendations

1. **The chat moves with the Accord by being copied into its record.** While an Accord is attached to a room, every room message is copied into the Accord's own append-only tables and its event log (`room.message`), keyed by room and the room's sequence number, so a resend changes nothing. The room keeps its own copy. When the Accord is exported, replayed, or attached to another room, its conversation goes with it. The alternative, linking to the room's log, breaks the moment the Accord leaves the room or the room's 5-minute replay window drops it.
2. **One Accord on a room's surface at a time, and one room per Accord at a time.** Then every message belongs to exactly one Accord with no tagging. Attaching another Accord detaches the first, and the first keeps everything it already carries. A room can still work through several Accords in sequence.
3. **Room membership is the roster.** The room's host is an Owner (beside the document's own Owner). Everyone else in the room is a participant, people and AIs alike. Someone who leaves stays on the roster, so their open dispositions still count, and anyone who has ever disposed still counts after the Accord moves rooms.
4. **Observers are an Accord setting that the host names, not a new room role.** By default everyone in the room is a participant. Making someone an observer is a deliberate act: they still argue and see every pile, but they don't dispose. The room passes `role: 'observer'`, or the Accord's existing observer setting names them.
5. **Arguments become room messages tagged to a proposal.** A message that begins `[for <id>]` or `[against <id>]` is also recorded as an argument by its sender, and it retires as arguments do today. This leaves one conversation instead of two, and the structured layer still drives retire and replay. A proper "reply to this proposal" button in the room would write the tag, so people never type it.
6. **A late joiner inherits the common accord, not an empty one.** Only open proposals land in their draft. An empty accord would make every newcomer a holdout on everything already settled. This is already the rule (`DISPOSITION_POLICY.lateJoinerInheritsCommon`).
7. **The Accord page drops what the room provides.** Opened as `/d/<slug>?surface=room`, it draws no chat and no Meet live link. Presence, video and the people list are the room's job.
8. **Rooms has to expose who is in the room, and what they say, to the surface.** `<soma-room>` today fires only `soma-room-proposal` and has no public member list. The bridge needs `members()`, `messages({after})`, and the events `soma-room-members` and `soma-room-message` (see `public/room-surface/bridge.js`). The room's signed-in identity also has to reach the embedded Accord, so the person shows as themselves and not as an unverified guest. This is the ask sent to @SR.
9. **In production the Rooms service, not the page, pushes to the Accord.** The prototype's page holds an Accord key. The real version is a server-to-server push with the key the team-room scripts already use (`ACCORD_TOKEN`).

## What the prototype does

- `src/shared/room-surface.ts` holds the rules: member and message validation, identity mapping (a person is their email, else `human:<room id>`; an AI is `ai:<name>`), the roster from the room, and argument tags.
- `server/room-surface.ts` holds three append-only tables: `document_room_bindings`, `document_room_roster` and `document_room_messages`. Each write is also a document event (`room.bound`, `room.unbound`, `room.members`, `room.message`).
- `server/dispositions.ts` `rosterFor`: on an attached Accord, the room roster replaces the team inferred from marks.
- Routes, all under `/api/agent/<slug>`, with an editor or owner key:

| Call | What |
|---|---|
| `POST /room/bind {roomId, roomName?, app?, members}` | Attach the Accord, or move it, to a room |
| `POST /room/unbind` | Detach it from its room |
| `POST /room/members {members}` | Send the room's current list |
| `POST /room/messages {roomId, messages}` | Copy chat in. Only the attached room is accepted, and resending is a no-op |
| `GET /room` | The attached room, its roster, and the messages the Accord carries |
| `GET /room/record` | The whole record for replay or export: rooms, messages, roster, dispositions, every argument |

- `public/room-surface/demo.html?slug=<slug>&token=<key>` puts a stub room beside the Accord in an iframe. You can add people and AIs, make someone an observer, talk, argue with `[against <id>]`, and move the Accord to a new room.
- Tests: `npm run test:room-surface` (17 cases) and `npm run check:room-surface` (browser, desktop and phone, screenshots in `.preview/room-surface-*.png`).

## Not done

- No real `<soma-room>` hookup yet. `somaRoomAdapter` throws until Rooms exposes the interface.
- The Accord page's own phone layout is cramped in a half-height iframe.
- The demo is not linked from anywhere, and nothing is deployed.
