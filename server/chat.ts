/**
 * Proof Documents Step B7 — chat beside the document: storage, posting, reading, events.
 *
 * Authorship: built by Claude Opus 5 (worker proof-chat), 2026-09-19, for Mike Wolf's "chat
 * sidebar" requirement and the COS's proposal. Rules are in CHAT_POLICY (src/shared/chat.ts).
 *
 * Chat rows live in document_chat_messages (server/db.ts). Nothing here writes to the document's
 * text, marks or Yjs state: a message that proposes a change carries a link to a suggestion that
 * the normal suggestion route created first (server/agent-routes.ts).
 */
import { addDocumentEvent, assertWritesAllowed, getDb, listDocumentAgentKeys } from './db.js';
import { broadcastToRoom } from './ws.js';
import {
  actorKey,
  agentKeyActor,
  isLineAnchor,
  resolveLineAnchor,
  type DocLine,
  type LineAnchor,
} from '../src/shared/line-marks.js';
import {
  CHAT_POLICY,
  cleanChatText,
  findMentions,
  isChatKind,
  mentionNamesFor,
  type ChatKind,
  type ChatSuggestionRef,
  type MentionCandidate,
  type ProofChatMessage,
} from '../src/shared/chat.js';
import { normalizeActorString } from '../src/shared/identity.js';
import { buildDirectory } from './identity.js';
import { documentOwnerActors, listLineMarks } from './line-marks.js';

export type ChatResult = { status: number; body: Record<string, unknown> };

interface ChatRow {
  id: number;
  document_slug: string;
  by_actor: string;
  kind: string;
  text: string;
  lines_json: string;
  mentions_json: string;
  reply_to: number | null;
  suggestion_json: string | null;
  comment_mark_id: string | null;
  created_at: string;
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

function rowToMessage(row: ChatRow): ProofChatMessage {
  return {
    id: row.id,
    by: row.by_actor,
    text: row.text,
    kind: isChatKind(row.kind) ? row.kind : 'message',
    lines: parseJson<unknown[]>(row.lines_json, []).filter(isLineAnchor) as LineAnchor[],
    mentions: parseJson<unknown[]>(row.mentions_json, []).filter((a): a is string => typeof a === 'string'),
    replyTo: typeof row.reply_to === 'number' ? row.reply_to : null,
    suggestion: parseJson<ChatSuggestionRef | null>(row.suggestion_json, null),
    commentMarkId: row.comment_mark_id,
    createdAt: row.created_at,
  };
}

/**
 * Messages in id order. With `after`, those after it (oldest first, at most `limit`); without it,
 * the newest `limit` messages (still oldest first).
 */
export function listChatMessages(slug: string, options: { after?: number | null; limit?: number } = {}): ProofChatMessage[] {
  const limit = Math.max(1, Math.min(CHAT_POLICY.maxPage, Math.floor(options.limit ?? CHAT_POLICY.defaultPage)));
  const db = getDb();
  if (typeof options.after === 'number' && Number.isFinite(options.after)) {
    const rows = db.prepare(`SELECT * FROM document_chat_messages WHERE document_slug = ? AND id > ? ORDER BY id ASC LIMIT ?`)
      .all(slug, Math.max(0, Math.floor(options.after)), limit) as ChatRow[];
    return rows.map(rowToMessage);
  }
  const rows = db.prepare(`SELECT * FROM document_chat_messages WHERE document_slug = ? ORDER BY id DESC LIMIT ?`)
    .all(slug, limit) as ChatRow[];
  return rows.reverse().map(rowToMessage);
}

export function getChatMessage(slug: string, id: number): ProofChatMessage | null {
  const row = getDb().prepare(`SELECT * FROM document_chat_messages WHERE document_slug = ? AND id = ?`).get(slug, id) as ChatRow | undefined;
  return row ? rowToMessage(row) : null;
}

export function chatAuthors(slug: string): string[] {
  try {
    const rows = getDb().prepare(`SELECT DISTINCT by_actor AS by FROM document_chat_messages WHERE document_slug = ?`).all(slug) as Array<{ by: string }>;
    return rows.map(r => r.by);
  } catch {
    return [];
  }
}

function insertChatMessage(slug: string, message: Omit<ProofChatMessage, 'id'>): number {
  assertWritesAllowed('insertChatMessage');
  const result = getDb().prepare(`
    INSERT INTO document_chat_messages (document_slug, by_actor, kind, text, lines_json, mentions_json, reply_to, suggestion_json, comment_mark_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(slug, message.by, message.kind, message.text, JSON.stringify(message.lines), JSON.stringify(message.mentions),
    message.replyTo, message.suggestion ? JSON.stringify(message.suggestion) : null, message.commentMarkId, message.createdAt);
  return Number(result.lastInsertRowid);
}

/** Everyone who can be @mentioned in this document's chat, with the names that mention them. */
export function mentionCandidates(slug: string): MentionCandidate[] {
  const dir = buildDirectory(slug);
  const out = new Map<string, MentionCandidate>();
  const add = (actor: string, label: string) => {
    const normalized = normalizeActorString(actor);
    if (!normalized) return;
    const key = actorKey(normalized);
    const entry = out.get(key) ?? { actor: normalized, names: [] };
    for (const name of mentionNamesFor(normalized, label)) if (!entry.names.includes(name)) entry.names.push(name);
    out.set(key, entry);
  };
  try {
    for (const key of listDocumentAgentKeys(slug).filter(k => !k.revokedAt)) add(agentKeyActor(key.label), key.label);
  } catch { /* agent keys are optional */ }
  for (const actor of documentOwnerActors(slug)) add(actor, dir.labels[actorKey(actor)] ?? '');
  try { for (const mark of listLineMarks(slug)) add(mark.by, dir.labels[actorKey(mark.by)] ?? ''); } catch { /* optional */ }
  for (const actor of chatAuthors(slug)) add(actor, dir.labels[actorKey(actor)] ?? '');
  return [...out.values()];
}

/** Resolves a message's pointers against the current lines (for the agent API and events). */
export function chatPointers(message: ProofChatMessage, lines: DocLine[]): Array<{ lineIndex: number | null; ref: string | null; text: string; current: boolean }> {
  return message.lines.map(anchor => {
    const resolved = resolveLineAnchor(lines, anchor);
    const line = resolved ? lines[resolved.lineIndex] : null;
    return {
      lineIndex: line?.index ?? null,
      ref: line ? `b${line.block + 1}` : null,
      text: (line?.text ?? anchor.excerpt ?? '').slice(0, 300),
      current: Boolean(resolved?.current),
    };
  });
}

export function serializeChatMessage(message: ProofChatMessage, lines: DocLine[] | null): Record<string, unknown> {
  return { ...message, ...(lines ? { pointers: chatPointers(message, lines) } : {}) };
}

function cleanAnchor(anchor: LineAnchor): LineAnchor {
  const out: LineAnchor = {
    hash: anchor.hash, occurrence: anchor.occurrence, ordinal: anchor.ordinal, kind: anchor.kind,
    excerpt: String(anchor.excerpt ?? '').slice(0, 80),
  };
  if (typeof anchor.text === 'string') out.text = anchor.text;
  return out;
}

export interface PostChatInput {
  by: string;
  text: unknown;
  kind?: ChatKind;
  anchors?: unknown;
  mentions?: unknown;
  replyTo?: unknown;
  suggestion?: ChatSuggestionRef | null;
  commentMarkId?: string | null;
  source: 'page' | 'agent' | 'server';
  /** Lines the pointers are checked against (optional: the page's anchors come from its own lines). */
  lines?: DocLine[];
}

/** Records one chat message, its `chat.message` event, and wakes the room. */
export function postChatMessage(slug: string, input: PostChatInput): ChatResult {
  const by = normalizeActorString(input.by);
  if (!by) return { status: 400, body: { success: false, code: 'INVALID_ACTOR', error: 'Missing or invalid "by"' } };
  let text = cleanChatText(input.text);
  if (!text && input.suggestion) text = 'Proposed a change.';
  if (!text) return { status: 400, body: { success: false, code: 'TEXT_REQUIRED', error: '"text" (the message) is required' } };
  const rawAnchors = input.anchors === undefined ? [] : input.anchors;
  if (!Array.isArray(rawAnchors)) return { status: 400, body: { success: false, code: 'INVALID_LINES', error: '"lines" must be a list' } };
  if (rawAnchors.length > CHAT_POLICY.maxLines) return { status: 400, body: { success: false, code: 'TOO_MANY_LINES', error: `At most ${CHAT_POLICY.maxLines} line pointers per message` } };
  const anchors: LineAnchor[] = [];
  for (const [index, raw] of rawAnchors.entries()) {
    if (!isLineAnchor(raw)) return { status: 400, body: { success: false, code: 'INVALID_ANCHOR', error: `lines[${index}] is not a line anchor`, index } };
    const anchor = cleanAnchor(raw as LineAnchor);
    if (!anchors.some(a => a.hash === anchor.hash && a.occurrence === anchor.occurrence)) anchors.push(anchor);
  }
  let replyTo: number | null = null;
  if (input.replyTo !== undefined && input.replyTo !== null) {
    const id = Number(input.replyTo);
    if (!Number.isInteger(id) || id <= 0 || !getChatMessage(slug, id)) {
      return { status: 404, body: { success: false, code: 'REPLY_TARGET_NOT_FOUND', error: '"replyTo" names no message in this document\'s chat' } };
    }
    replyTo = id;
  }
  // Mentions: the ones the composer picked (well-formed actors only) plus every @name in the text.
  const picked = Array.isArray(input.mentions)
    ? input.mentions.filter((a): a is string => typeof a === 'string' && a.length <= 200).map(a => normalizeActorString(a)).filter(Boolean)
    : [];
  let parsed: string[] = [];
  try { parsed = findMentions(text, mentionCandidates(slug)); } catch { parsed = []; }
  const mentions: string[] = [];
  for (const actor of [...picked, ...parsed]) {
    if (!mentions.some(a => actorKey(a) === actorKey(actor))) mentions.push(actor);
  }
  const message: Omit<ProofChatMessage, 'id'> = {
    by, text, kind: input.kind ?? 'message', lines: anchors, mentions: mentions.slice(0, CHAT_POLICY.maxMentions),
    replyTo, suggestion: input.suggestion ?? null, commentMarkId: input.commentMarkId ?? null, createdAt: new Date().toISOString(),
  };
  const id = insertChatMessage(slug, message);
  const saved: ProofChatMessage = { id, ...message };
  try {
    addDocumentEvent(slug, 'chat.message', {
      messageId: id, kind: saved.kind, text: saved.text, mentions: saved.mentions, replyTo: saved.replyTo,
      lines: input.lines ? chatPointers(saved, input.lines) : saved.lines.map(a => ({ excerpt: a.excerpt, hash: a.hash })),
      suggestion: saved.suggestion, commentMarkId: saved.commentMarkId, source: input.source,
      howToAnswer: `POST /api/agent/${slug}/chat {"text": "...", "replyTo": ${id}}`,
    }, by);
  } catch (error) {
    console.warn('[chat] failed to record event', { slug, error: String(error) });
  }
  broadcastToRoom(slug, { type: 'chat.updated', id, by, timestamp: saved.createdAt });
  return { status: 200, body: { success: true, message: input.lines ? serializeChatMessage(saved, input.lines) : saved, cursor: id } };
}
