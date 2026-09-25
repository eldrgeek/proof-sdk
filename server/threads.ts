/**
 * Accord round 2, stage D — server side of threads.
 *
 * A thread IS the comment or the suggestion that is already in the document. This module stores and
 * closes only the part a mark cannot carry: what would close the thread, what it is anchored to,
 * and who it waits on. Comments and suggestions with no row here still read as threads
 * (src/shared/threads.ts threadsFrom), so nothing on a live document is orphaned and there is no
 * migration to run.
 *
 * Every write records a document event (so a Familiar can follow along) and wakes open pages
 * through the same room broadcast line marks use.
 *
 * Authorship: Mike Wolf (rulings), built by Claude Opus 5 (worker accord-threads), 2026-09-22.
 */
import { randomUUID } from 'crypto';
import { addDocumentEvent } from './db.js';
import { broadcastToRoom } from './ws.js';
import { computeServerLines, parseStoredMarks } from './line-marks.js';
import { typedDiscussionInsertId } from '../src/shared/typed-discussion.js';
import {
  appendThreadReply,
  closeThreadRow,
  deleteThreadRow,
  getThreadRow,
  insertThreadRow,
  listThreadRows,
  reopenThreadRow,
  updateThreadAnchor,
} from './proof-extras-store.js';
import { actorKey, anchorForLine, isLineAnchor, resolveLineAnchor, type DocLine, type LineAnchor } from '../src/shared/line-marks.js';
import { slotOf } from '../src/shared/objections.js';
import {
  THREAD_ASK_LABEL,
  THREAD_POLICY,
  cleanThreadText,
  evaluateThread,
  isThreadAsks,
  reanchorThread,
  threadsFrom,
  type ThreadAnchorLine,
  type ThreadMeta,
  type ThreadStatus,
} from '../src/shared/threads.js';

export type ThreadResult = { status: number; body: Record<string, unknown> };

function fail(status: number, code: string, error: string): ThreadResult {
  return { status, body: { success: false, code, error } };
}

function event(slug: string, type: string, payload: Record<string, unknown>, by: string): void {
  try { addDocumentEvent(slug, type, payload, by); } catch (error) { console.warn('[threads] event failed', String(error)); }
  try { broadcastToRoom(slug, { type: 'document.threads', slug }); } catch { /* no room open */ }
}

function cleanAnchor(anchor: LineAnchor): LineAnchor {
  const out: LineAnchor = {
    hash: String(anchor.hash),
    occurrence: Number(anchor.occurrence) || 0,
    ordinal: Number(anchor.ordinal) || 0,
    kind: String(anchor.kind),
    excerpt: String(anchor.excerpt ?? '').slice(0, 80),
  };
  if (typeof anchor.text === 'string' && anchor.text) out.text = anchor.text.slice(0, 4000);
  return out;
}

/**
 * The lines a new thread is anchored to. The page sends the anchors it made from its own lines; the
 * server re-finds each one in the document it has, so a thread never starts anchored to text that
 * is not there.
 */
function anchorsFromBody(body: Record<string, unknown>, lines: DocLine[]): ThreadAnchorLine[] | null {
  const raw = Array.isArray(body.anchor) ? body.anchor : Array.isArray(body.anchors) ? body.anchors : null;
  if (!raw || raw.length === 0) return null;
  const out: ThreadAnchorLine[] = [];
  for (const entry of raw.slice(0, THREAD_POLICY.maxLines)) {
    const candidate = (entry && typeof entry === 'object' && 'original' in (entry as object))
      ? (entry as { original: unknown }).original
      : entry;
    if (!isLineAnchor(candidate)) continue;
    const anchor = cleanAnchor(candidate as LineAnchor);
    const found = resolveLineAnchor(lines, anchor);
    const line = found && found.current ? lines[found.lineIndex] : null;
    const current = line ? cleanAnchor(anchorForLine(line)) : anchor;
    out.push({ original: anchor, current, ...(line ? slotOf(lines, line.index) : { before: null, after: null }), deletedAt: null });
  }
  return out.length ? out : null;
}

/** A person (or an AI) started a thread on a range. Body: { markId?, asks, anchor[], selection?, waitingOn?, chatMessageId? }. */
export async function startThreadRow(slug: string, input: { by: string; body: Record<string, unknown>; markdown: string; isGuest?: boolean; source: 'page' | 'agent' }): Promise<ThreadResult> {
  const { body } = input;
  const asks = body.asks;
  if (!isThreadAsks(asks)) {
    return fail(400, 'CLOSING_CONDITION_REQUIRED', `A thread must say what would close it: one of ${Object.keys(THREAD_ASK_LABEL).join(', ')}`);
  }
  const markId = typeof body.markId === 'string' && body.markId.length <= 100 ? body.markId : null;
  const hasDiff = body.diff === true || asks === 'accept-reject';
  if (input.isGuest && hasDiff && !THREAD_POLICY.guestsMayPropose) {
    return fail(403, 'GUEST_MAY_NOT_PROPOSE', 'Guests may start a discussion, but not a proposal that edits the text');
  }
  const lines = await computeServerLines(input.markdown);
  const anchor = anchorsFromBody(body, lines);
  if (!anchor) return fail(400, 'INVALID_ANCHOR', 'A thread is anchored to at least one line');
  const waitingOn = Array.isArray(body.waitingOn)
    ? body.waitingOn.filter((actor): actor is string => typeof actor === 'string' && actor.length <= 200).slice(0, 50)
    : [];
  const meta: ThreadMeta = {
    id: typeof body.id === 'string' && body.id.length <= 100 ? body.id : randomUUID(),
    markId,
    by: input.by,
    asks,
    // The thread's own words, kept beside the document: deleting the text a thread is about must
    // not take what the thread said with it.
    text: cleanThreadText(body.text),
    anchor,
    selection: typeof body.selection === 'string' ? body.selection.slice(0, THREAD_POLICY.maxQuote) : null,
    waitingOn,
    status: 'open',
    createdAt: new Date().toISOString(),
    closedAt: null,
    closedBy: null,
    chatMessageId: typeof body.chatMessageId === 'number' ? body.chatMessageId : null,
  };
  insertThreadRow(slug, meta);
  const first = resolveLineAnchor(lines, anchor[0].current);
  event(slug, 'thread.started', {
    threadId: meta.id, markId, asks, closes: THREAD_ASK_LABEL[asks],
    lineIndex: first?.lineIndex ?? null, excerpt: anchor[0].current.excerpt,
    lines: anchor.length, waitingOn, source: input.source,
    howToAnswer: markId ? `Reply on the thread: POST /api/agent/${slug}/marks/reply {"markId": "${markId}", "text": "..."}` : 'Reply on the line',
  }, input.by);
  return { status: 200, body: { success: true, thread: meta, closes: THREAD_ASK_LABEL[asks] } };
}

/** Closes a thread: resolved / accepted / rejected / withdrawn. */
export async function closeThread(slug: string, input: { id: string; by: string; status: unknown; isOwner: boolean; markdown: string; source: 'page' | 'agent' }): Promise<ThreadResult> {
  const row = getThreadRow(slug, input.id);
  if (!row) return fail(404, 'THREAD_NOT_FOUND', 'No thread with that id');
  const status = String(input.status ?? 'resolved') as ThreadStatus;
  if (!['resolved', 'accepted', 'rejected', 'withdrawn'].includes(status)) {
    return fail(400, 'INVALID_STATUS', 'A thread closes as resolved, accepted, rejected or withdrawn');
  }
  if (status === 'withdrawn' && actorKey(row.by) !== actorKey(input.by) && !input.isOwner) {
    return fail(403, 'AUTHOR_REQUIRED', 'Only whoever started a thread (or an Owner) can withdraw it');
  }
  const at = new Date().toISOString();
  if (!closeThreadRow(slug, input.id, status, input.by, at)) {
    return fail(409, 'ALREADY_CLOSED', 'That thread is already closed');
  }
  event(slug, 'thread.closed', { threadId: input.id, markId: row.markId, status, asks: row.asks, source: input.source }, input.by);
  return { status: 200, body: { success: true, threadId: input.id, status, closedAt: at } };
}

/** The Undo of closing one (and the way a question comes back when the answer stops holding). */
export function reopenThread(slug: string, input: { id: string; by: string; source: 'page' | 'agent' }): ThreadResult {
  const row = getThreadRow(slug, input.id);
  if (!row) return fail(404, 'THREAD_NOT_FOUND', 'No thread with that id');
  if (!reopenThreadRow(slug, input.id)) return fail(409, 'ALREADY_OPEN', 'That thread is already open');
  event(slug, 'thread.reopened', { threadId: input.id, markId: row.markId, source: input.source }, input.by);
  return { status: 200, body: { success: true, threadId: input.id } };
}

/**
 * Accord round 2 stage C: a reply, stored on the thread's own row.
 *
 * The page also posts the reply to the thread's mark, as it always has, so nothing about how a
 * reply reads changes. What changes is that the thread now keeps its own copy: deleting the text a
 * thread sits on takes the mark and the mark's replies with it, and an unresolved disagreement must
 * never lose its discussion that way. src/shared/threads.ts mergeReplies shows each reply once.
 */
export function replyOnThread(slug: string, input: { id: string; by: string; text: string; at?: string; source: 'page' | 'agent' }): ThreadResult {
  const row = getThreadRow(slug, input.id);
  if (!row) return fail(404, 'THREAD_NOT_FOUND', 'No thread with that id');
  const text = cleanThreadText(input.text);
  if (!text) return fail(400, 'TEXT_REQUIRED', 'A reply needs some words');
  const at = input.at ?? new Date().toISOString();
  if (!appendThreadReply(slug, input.id, { by: input.by, text, at })) {
    return fail(409, 'NOT_STORED', 'That reply could not be stored');
  }
  event(slug, 'thread.replied', { threadId: input.id, markId: row.markId, source: input.source }, input.by);
  return { status: 200, body: { success: true, threadId: input.id } };
}

/** The Undo of starting one. Only whoever started it, and only while it is still open. */
export function undoStartThread(slug: string, input: { id: string; by: string; marks?: unknown }): ThreadResult {
  const row = getThreadRow(slug, input.id);
  if (!row) return fail(404, 'THREAD_NOT_FOUND', 'No thread with that id');
  if (actorKey(row.by) !== actorKey(input.by)) return fail(403, 'AUTHOR_REQUIRED', 'Only whoever started a thread can take it back');
  const typed = Boolean(typedDiscussionInsertId(row.id));
  const mark = row.markId ? parseStoredMarks(input.marks)[row.markId] : undefined;
  if (typed && (row.status !== 'open' || row.replies?.length || (Array.isArray(mark?.replies) && mark.replies.length)
    || (Array.isArray(mark?.thread) && mark.thread.length))) {
    return fail(409, 'DISCUSSION_HAS_REPLY', 'This discussion has been answered or closed. Keep its conversation.');
  }
  if (!deleteThreadRow(slug, input.id, row.by, typed)) return fail(409, 'NOT_REMOVED', 'That thread could not be taken back');
  event(slug, 'thread.withdrawn', { threadId: input.id, markId: row.markId }, input.by);
  return { status: 200, body: { success: true, threadId: input.id } };
}

/**
 * Re-anchors every thread against the document as it is now, so the stored anchor follows an edit
 * instead of drifting. A thread whose lines are all gone is NOT touched: its anchor stays what it
 * was, which is how the page knows to detach it and quote the original.
 */
export async function reanchorThreads(slug: string, markdown: string): Promise<number> {
  const lines = await computeServerLines(markdown);
  const rows = listThreadRows(slug);
  if (rows.length === 0) return 0;
  const now = new Date().toISOString();
  let moved = 0;
  for (const thread of threadsFrom({ lines, meta: rows })) {
    if (!thread.anchor.length) continue;
    const view = evaluateThread(thread, lines);
    if (view.detached) continue;
    if (!view.changed) continue;
    updateThreadAnchor(slug, thread.id, reanchorThread(thread, view, lines, now));
    moved += 1;
  }
  return moved;
}

/** Every thread row on a document (the page evaluates them against its own lines). */
export function threadRows(slug: string): ThreadMeta[] {
  return listThreadRows(slug);
}
