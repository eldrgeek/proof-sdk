/**
 * Accord as a surface inside a SOMA Room (pure code, shared by the browser and the server).
 *
 * Mike, 2026-11-05 (Claude project "Accords"): an Accord becomes a surface inside a SOMA Room.
 * Accord Chat goes away; the room's members, AIs and humans, are the Accord's participants; what
 * Rooms already provides is stripped from the Accord page. And: "The chat in a room with an accord
 * should move with the accord." Exploratory; the recommendations behind every switch below are in
 * docs/accord/room-surface.md, and each one is Claude's call that Mike can overrule.
 *
 * Read "moves with the accord" as: while an Accord is attached to a room, every room message is
 * copied into the Accord's own append-only record (keyed by room and the room's sequence number,
 * so a resend is a no-op). The Accord then carries its conversation when it is exported, replayed,
 * or attached to another room. The room keeps its own copy; nothing is taken away from it.
 *
 * Identity: a person in a room is their email when the room knows it (the same actor a signed-in
 * person already has in an Accord), otherwise `human:<room user id>`. An AI is `ai:<name>`, the
 * same actor an agent key's AI marks as.
 */
import { actorKey, agentKeyActor } from './line-marks.js';
import type { RosterEntry } from './dispositions.js';

export const ROOM_SURFACE_POLICY = {
  /** A room shows one Accord at a time; an Accord is attached to one room at a time. */
  accordsPerRoom: 'one-at-a-time' as const,
  /** Room messages are copied into the Accord's record while it is attached. */
  chatMovesWithAccord: true,
  /** On an attached Accord, the room's membership is the roster (not the team inferred from marks). */
  roomRosterReplacesInferredTeam: true,
  /** The room's host is an Owner of the Accord, beside the document's own Owner. */
  roomHostIsOwner: true,
  /**
   * Observers are an Accord setting the host names, not a separate room role: everyone in the room
   * is a participant unless named. An observer argues and sees every pile, and does not dispose.
   */
  observersFromRoom: 'host-names-them' as const,
  /**
   * A late joiner inherits the common accord; only open proposals land in their draft
   * (DISPOSITION_POLICY.lateJoinerInheritsCommon). An empty accord would make them a holdout on
   * everything already settled.
   */
  lateJoinerInheritsCommon: true,
  /** A room message tagged to a proposal ("[for <id>] …", "[against <id>] …") is also an argument. */
  taggedMessagesBecomeArguments: true,
  /** Leaving the room does not take a participant off the roster: their open dispositions still count. */
  leaversStayOnRoster: true,
  /** The Accord page, opened as a room surface, does not draw these: the room provides them. */
  strippedInSurface: ['chat', 'meet-live', 'agent-presence'] as const,
  /** The query parameter that opens the page as a room surface: /d/<slug>?surface=room. */
  surfaceParam: 'surface',
  surfaceValue: 'room',
  maxMembers: 64,
  maxMessagesPerPost: 200,
  maxText: 4000,
  maxName: 120,
} as const;

export type RoomMemberKind = 'person' | 'ai';
export type RoomMemberRole = 'host' | 'member' | 'observer';

export interface RoomMember {
  kind: RoomMemberKind;
  /** The room's own id: a SOMA Auth user id for a person, an agent or key id for an AI. */
  id: string;
  name: string;
  email?: string;
  role: RoomMemberRole;
  /** For an AI: the person who brought it. */
  sponsor?: { id: string; name: string };
}

export type RoomMessageKind = 'person' | 'ai' | 'system';
export type ArgumentStanceTag = 'for' | 'against';

export interface RoomMessage {
  /** The room's sequence number, unique within one room. */
  seq: number;
  kind: RoomMessageKind;
  /** The sender's room id (userId or agentId); absent for system messages. */
  from?: string;
  name?: string;
  text: string;
  at: string;
}

export interface RoomBinding {
  roomId: string;
  roomName: string;
  app: string | null;
  members: RoomMember[];
  boundBy: string;
  boundAt: string;
}

export function isRoomSurface(search: string | URLSearchParams | null | undefined): boolean {
  if (!search) return false;
  const params = typeof search === 'string' ? new URLSearchParams(search) : search;
  return params.get(ROOM_SURFACE_POLICY.surfaceParam) === ROOM_SURFACE_POLICY.surfaceValue;
}

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.normalize('NFC').trim().slice(0, max) : '');

export function parseRoomId(value: unknown): string | null {
  const id = str(value, 80);
  return /^[A-Za-z0-9_-]{1,80}$/.test(id) ? id : null;
}

/** Validated members, one per (kind, id); anything malformed is dropped. */
export function parseRoomMembers(raw: unknown): RoomMember[] {
  if (!Array.isArray(raw)) return [];
  const out: RoomMember[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const m = item as Record<string, unknown>;
    const kind = m.kind === 'ai' ? 'ai' : m.kind === 'person' ? 'person' : null;
    const id = str(m.id, 120);
    const name = str(m.name, ROOM_SURFACE_POLICY.maxName);
    if (!kind || !id || !name) continue;
    const key = `${kind}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const role: RoomMemberRole = m.role === 'host' ? 'host' : m.role === 'observer' ? 'observer' : 'member';
    const member: RoomMember = { kind, id, name, role };
    const email = str(m.email, 200).toLowerCase();
    if (kind === 'person' && /^[^\s@]+@[^\s@]+$/.test(email)) member.email = email;
    if (kind === 'ai' && m.sponsor && typeof m.sponsor === 'object') {
      const s = m.sponsor as Record<string, unknown>;
      const sid = str(s.id, 120), sname = str(s.name, ROOM_SURFACE_POLICY.maxName);
      if (sid && sname) member.sponsor = { id: sid, name: sname };
    }
    out.push(member);
    if (out.length >= ROOM_SURFACE_POLICY.maxMembers) break;
  }
  return out;
}

/** Validated messages, sorted by seq, one per seq. */
export function parseRoomMessages(raw: unknown): RoomMessage[] {
  if (!Array.isArray(raw)) return [];
  const bySeq = new Map<number, RoomMessage>();
  for (const item of raw.slice(0, ROOM_SURFACE_POLICY.maxMessagesPerPost)) {
    if (!item || typeof item !== 'object') continue;
    const m = item as Record<string, unknown>;
    const seq = typeof m.seq === 'number' && Number.isInteger(m.seq) && m.seq > 0 ? m.seq : null;
    const kind = m.kind === 'ai' || m.kind === 'person' || m.kind === 'system' ? m.kind : null;
    const text = typeof m.text === 'string' ? m.text.slice(0, ROOM_SURFACE_POLICY.maxText) : '';
    const at = str(m.at, 40);
    if (seq === null || !kind || !text.trim() || !at || Number.isNaN(Date.parse(at))) continue;
    const msg: RoomMessage = { seq, kind, text, at };
    const from = str(m.from ?? m.userId ?? m.agentId, 120);
    if (from && kind !== 'system') msg.from = from;
    const name = str(m.name, ROOM_SURFACE_POLICY.maxName);
    if (name) msg.name = name;
    if (!bySeq.has(seq)) bySeq.set(seq, msg);
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/** The Accord actor for a room member. */
export function memberActor(member: Pick<RoomMember, 'kind' | 'id' | 'name' | 'email'>): string {
  if (member.kind === 'ai') return agentKeyActor(member.name);
  return member.email ?? `human:${member.id}`;
}

/**
 * The Accord actor for a message's sender: the member it came from when the room listed them,
 * else the same rule applied to what the message says about itself. System messages are `room`.
 */
export function messageActor(message: RoomMessage, members: RoomMember[]): string {
  if (message.kind === 'system') return 'room';
  const member = members.find(m => m.kind === message.kind && m.id === message.from);
  if (member) return memberActor(member);
  return memberActor({ kind: message.kind, id: message.from ?? 'unknown', name: message.name ?? 'unknown' });
}

/**
 * The roster on an attached Accord: the host is an Owner, a named observer (by the room or by the
 * Accord's settings) is an observer, everyone else in the room is a participant, AIs and people alike.
 */
export function rosterFromRoom(members: RoomMember[], observers: string[] = []): RosterEntry[] {
  const observerKeys = new Set(observers.map(actorKey));
  const seen = new Set<string>();
  const roster: RosterEntry[] = [];
  for (const member of members) {
    const actor = memberActor(member);
    const key = actorKey(actor);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const role = member.role === 'host' && ROOM_SURFACE_POLICY.roomHostIsOwner ? 'owner'
      : member.role === 'observer' || observerKeys.has(key) ? 'observer' : 'participant';
    roster.push({ actor, role });
  }
  return roster;
}

/**
 * A message's argument tag: "[for <markId>] text" or "[against <markId>] text" at the start.
 * Returns the stance, the mark id and the text without the tag, or null.
 */
export function parseArgumentTag(text: string): { stance: ArgumentStanceTag; markId: string; text: string } | null {
  const match = /^\s*\[(for|against)\s+([A-Za-z0-9_:-]{1,120})\]\s*([\s\S]*)$/i.exec(text);
  if (!match) return null;
  const rest = match[3].trim();
  if (!rest) return null;
  return { stance: match[1].toLowerCase() as ArgumentStanceTag, markId: match[2], text: rest };
}

/** True when two member lists name the same people with the same roles (order ignored). */
export function sameMembers(a: RoomMember[], b: RoomMember[]): boolean {
  const sig = (list: RoomMember[]) => list.map(m => `${m.kind}:${m.id}:${m.role}:${m.email ?? ''}:${m.name}`).sort().join('|');
  return sig(a) === sig(b);
}
