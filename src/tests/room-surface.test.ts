// Accord as a SOMA Room surface (src/shared/room-surface.ts, server/room-surface.ts).
// Mike, 2026-11-05: room members are the Accord's participants; "the chat in a room with an accord
// should move with the accord".
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { createServer } from 'node:http';
import {
  isRoomSurface, memberActor, messageActor, parseArgumentTag, parseRoomMembers, parseRoomMessages, rosterFromRoom, sameMembers,
} from '../shared/room-surface';

const temp = mkdtempSync(path.join(tmpdir(), 'proof-room-surface-'));
process.env.DATABASE_PATH = path.join(temp, 'test.db');
const db = await import('../../server/db');
const { apiRoutes } = await import('../../server/routes');
const { agentRoutes } = await import('../../server/agent-routes');

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

// ---- pure rules ----
await test('the surface opens only on ?surface=room', () => {
  assert.equal(isRoomSurface('?surface=room'), true);
  assert.equal(isRoomSurface('?surface=room&token=x'), true);
  assert.equal(isRoomSurface('?surface=page'), false);
  assert.equal(isRoomSurface(''), false);
});

await test('members are validated and identities map to Accord actors', () => {
  const members = parseRoomMembers([
    { kind: 'person', id: 'u1', name: 'Mike', email: 'Mike@Example.com', role: 'host' },
    { kind: 'person', id: 'u2', name: 'Guest' },
    { kind: 'ai', id: 'a1', name: 'Claude', sponsor: { id: 'u1', name: 'Mike' } },
    { kind: 'robot', id: 'x', name: 'nope' },
    { kind: 'person', id: 'u1', name: 'Mike again' },
    { kind: 'person', name: 'no id' },
  ]);
  assert.equal(members.length, 3);
  assert.equal(memberActor(members[0]), 'mike@example.com');
  assert.equal(memberActor(members[1]), 'human:u2');
  assert.equal(memberActor(members[2]), 'ai:claude');
  assert.equal(members[1].role, 'member');
});

await test('the roster: host is an Owner, observers observe, everyone else participates (AIs too)', () => {
  const members = parseRoomMembers([
    { kind: 'person', id: 'u1', name: 'Mike', email: 'mike@x.co', role: 'host' },
    { kind: 'person', id: 'u2', name: 'Noel', email: 'noel@x.co' },
    { kind: 'person', id: 'u3', name: 'Jess', email: 'jess@x.co', role: 'observer' },
    { kind: 'ai', id: 'a1', name: 'Claude' },
    { kind: 'ai', id: 'a2', name: 'Gemini' },
  ]);
  const roster = rosterFromRoom(members, ['ai:gemini']);
  assert.deepEqual(roster.map(e => [e.actor, e.role]), [
    ['mike@x.co', 'owner'], ['noel@x.co', 'participant'], ['jess@x.co', 'observer'], ['ai:claude', 'participant'], ['ai:gemini', 'observer'],
  ]);
});

await test('messages are validated, de-duplicated by seq and sorted', () => {
  const msgs = parseRoomMessages([
    { seq: 2, kind: 'ai', agentId: 'a1', name: 'Claude', text: 'second', at: '2026-11-05T10:00:02Z' },
    { seq: 1, kind: 'person', userId: 'u1', name: 'Mike', text: 'first', at: '2026-11-05T10:00:01Z' },
    { seq: 1, kind: 'person', userId: 'u1', name: 'Mike', text: 'dupe', at: '2026-11-05T10:00:01Z' },
    { seq: 3, kind: 'person', text: '   ', at: '2026-11-05T10:00:03Z' },
    { seq: 0, kind: 'person', text: 'bad seq', at: '2026-11-05T10:00:03Z' },
  ]);
  assert.deepEqual(msgs.map(m => [m.seq, m.text, m.from]), [[1, 'first', 'u1'], [2, 'second', 'a1']]);
  const members = parseRoomMembers([{ kind: 'person', id: 'u1', name: 'Mike', email: 'mike@x.co' }]);
  assert.equal(messageActor(msgs[0], members), 'mike@x.co');
  assert.equal(messageActor(msgs[1], members), 'ai:claude');
  assert.equal(messageActor({ seq: 9, kind: 'system', text: 'x', at: 'y' }, members), 'room');
});

await test('argument tags: "[for <id>] …" and "[against <id>] …"', () => {
  assert.deepEqual(parseArgumentTag('[for m-1] Customers asked for it.'), { stance: 'for', markId: 'm-1', text: 'Customers asked for it.' });
  assert.deepEqual(parseArgumentTag('  [Against abc_2]  too late'), { stance: 'against', markId: 'abc_2', text: 'too late' });
  assert.equal(parseArgumentTag('[for m-1]'), null);
  assert.equal(parseArgumentTag('I am for m-1'), null);
});

await test('sameMembers ignores order', () => {
  const a = parseRoomMembers([{ kind: 'person', id: 'u1', name: 'A' }, { kind: 'ai', id: 'a1', name: 'B' }]);
  assert.equal(sameMembers(a, [...a].reverse()), true);
  assert.equal(sameMembers(a, a.slice(1)), false);
});

// ---- routes ----
const app = express();
app.use(express.json());
app.use('/api', apiRoutes);
app.use('/api/agent', agentRoutes);
const server = createServer(app);
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const clientHeaders = { 'X-Proof-Client-Version': '0.34.0', 'X-Proof-Client-Build': 'test', 'X-Proof-Client-Protocol': '3' };
const call = async (url: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => {
  const response = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...clientHeaders, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, any> };
};

const doc = `# Plan

Launch moves to September 30 for every customer.

Budget line stays the same for the quarter.`;

try {
  const slug = 'room-surface-test';
  const other = 'room-surface-other';
  db.createDocument(slug, doc, {}, 'Room surface test', 'owner-1', 'owner-secret-123');
  db.createDocument(other, doc, {}, 'Other accord', 'owner-2', 'owner-secret-456');
  const OWNER = { 'x-share-token': 'owner-secret-123' };
  const OTHER_OWNER = { 'x-share-token': 'owner-secret-456' };
  const bridgeKey = { 'x-share-token': db.createDocumentAccessToken(slug, 'editor', undefined, { label: 'Room bridge', requestedBy: 'test', requestedFrom: '127.0.0.1' }).secret };
  const viewer = { 'x-share-token': db.createDocumentAccessToken(slug, 'viewer').secret };
  const members = [
    { kind: 'person', id: 'u-mike', name: 'Mike', email: 'mike@x.co', role: 'host' },
    { kind: 'person', id: 'u-noel', name: 'Noel', email: 'noel@x.co' },
    { kind: 'ai', id: 'a-claude', name: 'Claude' },
  ];
  const msg = (seq: number, from: string, name: string, text: string, kind = 'person') => ({ seq, kind, from, name, text, at: new Date(Date.UTC(2026, 10, 5, 10, 0, seq)).toISOString() });

  await test('messages before the Accord is attached are refused', async () => {
    const r = await call(`/api/agent/${slug}/room/messages`, 'POST', { roomId: 'room-a', messages: [msg(1, 'u-mike', 'Mike', 'hello')] }, bridgeKey);
    assert.equal(r.status, 409); assert.equal(r.body.code, 'NOT_ATTACHED');
  });

  await test('a viewer key cannot attach a room', async () => {
    const r = await call(`/api/agent/${slug}/room/bind`, 'POST', { roomId: 'room-a', members }, viewer);
    assert.ok(r.status === 401 || r.status === 403, String(r.status));
  });

  await test('attaching: the room roster replaces the inferred team', async () => {
    const r = await call(`/api/agent/${slug}/room/bind`, 'POST', { roomId: 'room-a', roomName: 'Room A', members }, bridgeKey);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.binding.roomId, 'room-a');
    assert.deepEqual(r.body.roster.map((e: any) => [e.actor, e.role]), [['mike@x.co', 'owner'], ['noel@x.co', 'participant'], ['ai:claude', 'participant']]);
    const report = await call(`/api/agent/${slug}/dispositions`, 'GET', undefined, bridgeKey);
    const actors = report.body.roster.map((e: any) => e.actor);
    for (const a of ['mike@x.co', 'noel@x.co', 'ai:claude']) assert.ok(actors.includes(a), `${a} in ${actors}`);
    assert.equal(report.body.roster.find((e: any) => e.actor === 'mike@x.co').role, 'owner');
    // The bridge's own key is not a participant: it relays, it does not decide.
    assert.ok(!actors.includes('ai:room-bridge'), String(actors));
  });

  await test('room chat is copied into the Accord, and a resend is a no-op', async () => {
    const batch = [msg(1, 'u-mike', 'Mike', 'Can we move the launch?'), msg(2, 'a-claude', 'Claude', 'I proposed October 14.', 'ai')];
    const first = await call(`/api/agent/${slug}/room/messages`, 'POST', { roomId: 'room-a', messages: batch }, bridgeKey);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.added, 2);
    const again = await call(`/api/agent/${slug}/room/messages`, 'POST', { roomId: 'room-a', messages: batch }, bridgeKey);
    assert.equal(again.body.added, 0); assert.equal(again.body.duplicates, 2);
    const room = await call(`/api/agent/${slug}/room`, 'GET', undefined, viewer);
    assert.deepEqual(room.body.messages.map((m: any) => [m.seq, m.actor]), [[1, 'mike@x.co'], [2, 'ai:claude']]);
  });

  await test('a message from another room is refused', async () => {
    const r = await call(`/api/agent/${slug}/room/messages`, 'POST', { roomId: 'room-z', messages: [msg(3, 'u-x', 'X', 'hi')] }, bridgeKey);
    assert.equal(r.status, 409); assert.equal(r.body.code, 'WRONG_ROOM');
  });

  await test('a message tagged to a proposal also records an argument by its sender', async () => {
    await call(`/api/agent/${slug}/dispositions/settings`, 'POST', { multiParty: true, by: 'mike@x.co' }, OWNER);
    const s = await call(`/api/agent/${slug}/marks/suggest-replace`, 'POST', { quote: 'September 30', content: 'October 14', why: 'Test' }, bridgeKey);
    assert.equal(s.status, 200, JSON.stringify(s.body));
    const markId = s.body.markId ?? s.body.suggestion?.markId ?? Object.entries(s.body.marks ?? {}).find(([, m]: [string, any]) => m.quote === 'September 30' && m.status === 'pending')?.[0];
    assert.ok(markId);
    const r = await call(`/api/agent/${slug}/room/messages`, 'POST', { roomId: 'room-a', messages: [msg(3, 'u-noel', 'Noel', `[against ${markId}] Our customers already planned for September.`)] }, bridgeKey);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.argued[0].outcome, 'recorded', JSON.stringify(r.body.argued));
    const report = await call(`/api/agent/${slug}/dispositions`, 'GET', undefined, bridgeKey);
    const arg = report.body.arguments.find((a: any) => a.markId === markId);
    assert.equal(arg.by, 'noel@x.co'); assert.equal(arg.stance, 'against');
    assert.equal(arg.text, 'Our customers already planned for September.');
  });

  await test('the room names an observer: they stay on the roster but do not dispose', async () => {
    const next = members.map(m => m.id === 'u-noel' ? { ...m, role: 'observer' } : m);
    const r = await call(`/api/agent/${slug}/room/members`, 'POST', { members: next }, bridgeKey);
    assert.equal(r.status, 200); assert.equal(r.body.changed, true);
    assert.equal(r.body.roster.find((e: any) => e.actor === 'noel@x.co').role, 'observer');
    const same = await call(`/api/agent/${slug}/room/members`, 'POST', { members: next }, bridgeKey);
    assert.equal(same.body.changed, false);
  });

  await test('someone who leaves the room stays on the roster', async () => {
    const r = await call(`/api/agent/${slug}/room/members`, 'POST', { members: members.filter(m => m.id !== 'a-claude') }, bridgeKey);
    assert.ok(r.body.roster.some((e: any) => e.actor === 'ai:claude'));
  });

  await test('moving the Accord to another room: the chat moves with it, the old room is detached', async () => {
    const r = await call(`/api/agent/${slug}/room/bind`, 'POST', { roomId: 'room-b', roomName: 'Room B', members: [{ kind: 'person', id: 'u-jess', name: 'Jess', email: 'jess@x.co', role: 'host' }] }, bridgeKey);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.moved, { from: 'room-a' });
    const stale = await call(`/api/agent/${slug}/room/messages`, 'POST', { roomId: 'room-a', messages: [msg(4, 'u-mike', 'Mike', 'still here?')] }, bridgeKey);
    assert.equal(stale.body.code, 'WRONG_ROOM');
    const fresh = await call(`/api/agent/${slug}/room/messages`, 'POST', { roomId: 'room-b', messages: [msg(1, 'u-jess', 'Jess', 'Picking this up.')] }, bridgeKey);
    assert.equal(fresh.body.added, 1, 'seq 1 again is new in a new room');
    const record = await call(`/api/agent/${slug}/room/record`, 'GET', undefined, viewer);
    assert.equal(record.status, 200);
    assert.deepEqual(record.body.rooms.map((b: any) => [b.roomId, b.unboundAt === null]), [['room-a', false], ['room-b', true]]);
    assert.deepEqual(record.body.messages.map((m: any) => `${m.roomId}#${m.seq}`), ['room-a#1', 'room-a#2', 'room-a#3', 'room-b#1']);
    assert.ok(record.body.allArguments.length >= 1);
    // The room's roster now: Jess hosts; earlier participants who disposed would still count.
    assert.equal(record.body.roster.find((e: any) => e.actor === 'jess@x.co').role, 'owner');
  });

  await test('one Accord per room: attaching another Accord detaches this one', async () => {
    const r = await call(`/api/agent/${other}/room/bind`, 'POST', { roomId: 'room-b', members: [], by: 'mike@x.co' }, OTHER_OWNER);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.detached, [slug]);
    const mine = await call(`/api/agent/${slug}/room`, 'GET', undefined, viewer);
    assert.equal(mine.body.binding, null);
    assert.equal(mine.body.messages.length, 4, 'the detached Accord keeps its conversation');
  });

  await test('the replay log carries room events in order', async () => {
    const events = db.listDocumentEvents(slug, 0, 500).map((e: any) => e.event_type).filter((t: string) => t.startsWith('room.'));
    assert.deepEqual(events.slice(0, 2), ['room.bound', 'room.message']);
    assert.ok(events.includes('room.members'));
    assert.ok(events.filter((t: string) => t === 'room.unbound').length >= 2);
  });

  console.log(`\n${passed} room-surface tests passed`);
} finally {
  server.close();
  rmSync(temp, { recursive: true, force: true });
}
