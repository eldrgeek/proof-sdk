/**
 * Accord as a room surface: the server half (src/shared/room-surface.ts has the rules).
 *
 * Mike, 2026-11-05: room members are the Accord's participants, and "the chat in a room with an
 * accord should move with the accord". Three append-only tables beside the document:
 *
 *   document_room_bindings  — which room the Accord is attached to, and when it moved.
 *   document_room_roster    — everyone the attached room has listed (first and last seen).
 *   document_room_messages  — every room message seen while attached, unique by (room, seq).
 *
 * Every write also lands in document_events (room.bound, room.unbound, room.members,
 * room.message), so the Accord's record replays in one ordered stream with its dispositions,
 * arguments and overrules.
 */
import { addDocumentEvent, assertWritesAllowed, getDb } from './db.js';
import { actorKey } from '../src/shared/line-marks.js';
import type { RosterEntry } from '../src/shared/dispositions.js';
import {
  ROOM_SURFACE_POLICY,
  messageActor,
  parseArgumentTag,
  rosterFromRoom,
  sameMembers,
  type RoomBinding,
  type RoomMember,
  type RoomMessage,
} from '../src/shared/room-surface.js';

let tablesReady = false;
function ensureTables(): void {
  if (tablesReady) return;
  const d = getDb();
  d.exec(`
    CREATE TABLE IF NOT EXISTS document_room_bindings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_slug TEXT NOT NULL,
      room_id TEXT NOT NULL,
      room_name TEXT NOT NULL,
      app TEXT,
      members_json TEXT NOT NULL DEFAULT '[]',
      bound_by TEXT NOT NULL,
      bound_at TEXT NOT NULL,
      unbound_at TEXT
    )
  `);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_document_room_bindings_slug ON document_room_bindings(document_slug, id)`);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_document_room_bindings_room ON document_room_bindings(room_id, unbound_at)`);
  d.exec(`
    CREATE TABLE IF NOT EXISTS document_room_roster (
      document_slug TEXT NOT NULL,
      room_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      member_id TEXT NOT NULL,
      name TEXT NOT NULL,
      email TEXT,
      role TEXT NOT NULL,
      actor TEXT NOT NULL,
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      PRIMARY KEY (document_slug, room_id, kind, member_id)
    )
  `);
  d.exec(`
    CREATE TABLE IF NOT EXISTS document_room_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_slug TEXT NOT NULL,
      room_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      kind TEXT NOT NULL,
      actor TEXT NOT NULL,
      name TEXT,
      text TEXT NOT NULL,
      at TEXT NOT NULL,
      argument_mark_id TEXT,
      argument_stance TEXT,
      ingested_at TEXT NOT NULL,
      UNIQUE (document_slug, room_id, seq)
    )
  `);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_document_room_messages_slug ON document_room_messages(document_slug, id)`);
  tablesReady = true;
}

interface BindingRow { id: number; room_id: string; room_name: string; app: string | null; members_json: string; bound_by: string; bound_at: string; unbound_at: string | null }

function rowToBinding(row: BindingRow): RoomBinding {
  let members: RoomMember[] = [];
  try { const parsed = JSON.parse(row.members_json) as unknown; if (Array.isArray(parsed)) members = parsed as RoomMember[]; } catch { /* none */ }
  return { roomId: row.room_id, roomName: row.room_name, app: row.app, members, boundBy: row.bound_by, boundAt: row.bound_at };
}

function currentRow(slug: string): BindingRow | undefined {
  ensureTables();
  return getDb().prepare(`SELECT * FROM document_room_bindings WHERE document_slug = ? AND unbound_at IS NULL ORDER BY id DESC LIMIT 1`)
    .get(slug) as BindingRow | undefined;
}

export function currentBinding(slug: string): RoomBinding | null {
  try { const row = currentRow(slug); return row ? rowToBinding(row) : null; } catch { return null; }
}

function noteRoster(slug: string, roomId: string, members: RoomMember[], at: string): void {
  const upsert = getDb().prepare(`
    INSERT INTO document_room_roster (document_slug, room_id, kind, member_id, name, email, role, actor, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(document_slug, room_id, kind, member_id) DO UPDATE SET
      name = excluded.name, email = COALESCE(excluded.email, document_room_roster.email),
      role = excluded.role, actor = excluded.actor, last_seen = excluded.last_seen
  `);
  for (const m of members) {
    const actor = rosterFromRoom([m])[0]?.actor;
    if (!actor) continue;
    upsert.run(slug, roomId, m.kind, m.id, m.name, m.email ?? null, m.role, actor, at, at);
  }
}

export type BindOutcome = { binding: RoomBinding; moved: { from: string } | null; detached: string[]; changed: boolean };

/**
 * Attach this Accord to a room. An Accord sits in one room at a time, and a room shows one Accord
 * at a time, so this detaches the Accord from any other room and any other Accord from this room.
 * The messages already copied stay with the Accord: that is what "moves with the accord" means.
 */
export function bindRoom(slug: string, input: { roomId: string; roomName: string; app: string | null; members: RoomMember[]; by: string }): BindOutcome {
  assertWritesAllowed('bindRoom');
  ensureTables();
  const d = getDb();
  const at = new Date().toISOString();
  const current = currentRow(slug);
  if (current && current.room_id === input.roomId) {
    const changed = updateMembers(slug, input.members, input.by);
    return { binding: currentBinding(slug)!, moved: null, detached: [], changed };
  }
  const detached: string[] = [];
  const tx = d.transaction(() => {
    if (current) {
      d.prepare(`UPDATE document_room_bindings SET unbound_at = ? WHERE id = ?`).run(at, current.id);
      addDocumentEvent(slug, 'room.unbound', { roomId: current.room_id, reason: 'moved', to: input.roomId }, input.by);
    }
    const others = d.prepare(`SELECT id, document_slug FROM document_room_bindings WHERE room_id = ? AND unbound_at IS NULL AND document_slug != ?`)
      .all(input.roomId, slug) as Array<{ id: number; document_slug: string }>;
    for (const other of others) {
      d.prepare(`UPDATE document_room_bindings SET unbound_at = ? WHERE id = ?`).run(at, other.id);
      addDocumentEvent(other.document_slug, 'room.unbound', { roomId: input.roomId, reason: 'replaced', by: slug }, input.by);
      detached.push(other.document_slug);
    }
    d.prepare(`
      INSERT INTO document_room_bindings (document_slug, room_id, room_name, app, members_json, bound_by, bound_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(slug, input.roomId, input.roomName, input.app, JSON.stringify(input.members), input.by, at);
    noteRoster(slug, input.roomId, input.members, at);
    addDocumentEvent(slug, 'room.bound', { roomId: input.roomId, roomName: input.roomName, app: input.app, members: input.members, from: current?.room_id ?? null }, input.by);
  });
  tx();
  return { binding: currentBinding(slug)!, moved: current ? { from: current.room_id } : null, detached, changed: true };
}

export function unbindRoom(slug: string, by: string): boolean {
  assertWritesAllowed('unbindRoom');
  const current = currentRow(slug);
  if (!current) return false;
  getDb().prepare(`UPDATE document_room_bindings SET unbound_at = ? WHERE id = ?`).run(new Date().toISOString(), current.id);
  addDocumentEvent(slug, 'room.unbound', { roomId: current.room_id, reason: 'detached' }, by);
  return true;
}

/** The room's member list changed. Records a room.members event only when it really did. */
export function updateMembers(slug: string, members: RoomMember[], by: string): boolean {
  assertWritesAllowed('updateRoomMembers');
  const current = currentRow(slug);
  if (!current) return false;
  const before = rowToBinding(current).members;
  if (sameMembers(before, members)) return false;
  const at = new Date().toISOString();
  getDb().prepare(`UPDATE document_room_bindings SET members_json = ? WHERE id = ?`).run(JSON.stringify(members), current.id);
  noteRoster(slug, current.room_id, members, at);
  addDocumentEvent(slug, 'room.members', { roomId: current.room_id, members }, by);
  return true;
}

/**
 * The roster of an attached Accord: everyone the current room has listed while attached
 * (ROOM_SURFACE_POLICY.leaversStayOnRoster), with their latest role. Null when not attached.
 */
export function roomRoster(slug: string, observers: string[] = []): RosterEntry[] | null {
  try {
    const current = currentRow(slug);
    if (!current) return null;
    const rows = getDb().prepare(`SELECT kind, member_id, name, email, role FROM document_room_roster WHERE document_slug = ? AND room_id = ? ORDER BY first_seen ASC, rowid ASC`)
      .all(slug, current.room_id) as Array<{ kind: 'person' | 'ai'; member_id: string; name: string; email: string | null; role: RoomMember['role'] }>;
    const members: RoomMember[] = rows.map(r => ({ kind: r.kind, id: r.member_id, name: r.name, role: r.role, ...(r.email ? { email: r.email } : {}) }));
    return rosterFromRoom(members, observers);
  } catch {
    return null;
  }
}

export interface StoredRoomMessage {
  id: number;
  roomId: string;
  seq: number;
  kind: RoomMessage['kind'];
  actor: string;
  name: string | null;
  text: string;
  at: string;
  argument: { markId: string; stance: 'for' | 'against' } | null;
}

export type IngestOutcome =
  | { kind: 'not-attached' }
  | { kind: 'wrong-room'; attachedTo: string }
  | { kind: 'ingested'; added: StoredRoomMessage[]; duplicates: number; tagged: Array<{ message: StoredRoomMessage; markId: string; stance: 'for' | 'against'; text: string }> };

/**
 * Copy room messages into the Accord. Only the room the Accord is attached to may add messages,
 * and a message already copied (same room, same seq) is skipped, so the bridge can resend freely.
 * Messages tagged "[for <id>]" or "[against <id>]" are returned so the caller can record them as
 * arguments through the dispositions module (which keeps its own rules about who may argue).
 */
export function ingestMessages(slug: string, roomId: string, messages: RoomMessage[]): IngestOutcome {
  assertWritesAllowed('ingestRoomMessages');
  const current = currentRow(slug);
  if (!current) return { kind: 'not-attached' };
  if (current.room_id !== roomId) return { kind: 'wrong-room', attachedTo: current.room_id };
  const members = rowToBinding(current).members;
  const d = getDb();
  const insert = d.prepare(`
    INSERT OR IGNORE INTO document_room_messages (document_slug, room_id, seq, kind, actor, name, text, at, argument_mark_id, argument_stance, ingested_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const added: StoredRoomMessage[] = [];
  const tagged: Array<{ message: StoredRoomMessage; markId: string; stance: 'for' | 'against'; text: string }> = [];
  let duplicates = 0;
  const now = new Date().toISOString();
  const tx = d.transaction(() => {
    for (const message of messages) {
      const actor = messageActor(message, members);
      const tag = ROOM_SURFACE_POLICY.taggedMessagesBecomeArguments && message.kind !== 'system' ? parseArgumentTag(message.text) : null;
      const info = insert.run(slug, roomId, message.seq, message.kind, actor, message.name ?? null, message.text, message.at, tag?.markId ?? null, tag?.stance ?? null, now);
      if (info.changes === 0) { duplicates += 1; continue; }
      const stored: StoredRoomMessage = {
        id: Number(info.lastInsertRowid), roomId, seq: message.seq, kind: message.kind, actor, name: message.name ?? null,
        text: message.text, at: message.at, argument: tag ? { markId: tag.markId, stance: tag.stance } : null,
      };
      added.push(stored);
      if (tag) tagged.push({ message: stored, markId: tag.markId, stance: tag.stance, text: tag.text });
      addDocumentEvent(slug, 'room.message', { roomId, seq: message.seq, kind: message.kind, name: message.name ?? null, text: message.text, at: message.at, argument: stored.argument }, actor);
    }
  });
  tx();
  return { kind: 'ingested', added, duplicates, tagged };
}

interface MessageRow { id: number; room_id: string; seq: number; kind: RoomMessage['kind']; actor: string; name: string | null; text: string; at: string; argument_mark_id: string | null; argument_stance: 'for' | 'against' | null }
const rowToMessage = (r: MessageRow): StoredRoomMessage => ({
  id: r.id, roomId: r.room_id, seq: r.seq, kind: r.kind, actor: r.actor, name: r.name, text: r.text, at: r.at,
  argument: r.argument_mark_id && r.argument_stance ? { markId: r.argument_mark_id, stance: r.argument_stance } : null,
});

/** Every room message this Accord carries, from every room it has been in, in the order copied. */
export function listRoomMessages(slug: string, afterId = 0, limit = 500): StoredRoomMessage[] {
  try {
    ensureTables();
    const rows = getDb().prepare(`SELECT * FROM document_room_messages WHERE document_slug = ? AND id > ? ORDER BY id ASC LIMIT ?`)
      .all(slug, afterId, Math.max(1, Math.min(limit, 2000))) as MessageRow[];
    return rows.map(rowToMessage);
  } catch {
    return [];
  }
}

export interface BindingHistoryEntry { roomId: string; roomName: string; app: string | null; boundBy: string; boundAt: string; unboundAt: string | null }

export function bindingHistory(slug: string): BindingHistoryEntry[] {
  try {
    ensureTables();
    const rows = getDb().prepare(`SELECT * FROM document_room_bindings WHERE document_slug = ? ORDER BY id ASC`).all(slug) as BindingRow[];
    return rows.map(r => ({ roomId: r.room_id, roomName: r.room_name, app: r.app, boundBy: r.bound_by, boundAt: r.bound_at, unboundAt: r.unbound_at }));
  } catch {
    return [];
  }
}

/** True when this actor is on the attached room's roster (people and AIs alike). */
export function isOnRoomRoster(slug: string, actor: string): boolean {
  const roster = roomRoster(slug);
  return !!roster && roster.some(entry => actorKey(entry.actor) === actorKey(actor));
}
